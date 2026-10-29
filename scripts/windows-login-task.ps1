param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('status', 'register', 'start', 'stop', 'restart', 'uninstall', 'probe', 'run')]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$Manifest,
  [string]$ProbeResult
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# Kept in step with RELAUNCH_EXIT_CODE in login-service-runner.mjs.
$FleetRelaunchExitCode = 75
# STATUS_CONTROL_C_EXIT: Ctrl+C or Ctrl+Break ended the runner before it could handle it.
$FleetControlCExitCode = -1073741510
$FleetRelaunchLimitPerHour = 5

function Get-FleetFullPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '[\x00\r\n"]' -or
      $Path -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\/?]+\\[^\\/]+(?:\\|$))') {
    throw 'Login-start paths must be fully qualified Windows paths.'
  }
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  if ($full.Length -gt $root.Length) { $full = $full.TrimEnd('\', '/') }
  return $full
}

function Test-FleetPath([string]$Left, [string]$Right) {
  return [string]::Equals((Get-FleetFullPath $Left), (Get-FleetFullPath $Right), [StringComparison]::OrdinalIgnoreCase)
}

function ConvertTo-FleetArgument([string]$Value) {
  # CommandLineToArgvW/CRT quoting, not PowerShell source interpolation.
  return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Get-FleetPowerShell {
  return Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe'
}

function Resolve-FleetSid([string]$Account) {
  if ($Account -match '^S-\d+(?:-\d+)+$') {
    return ([Security.Principal.SecurityIdentifier]::new($Account)).Value
  }
  return ([Security.Principal.NTAccount]::new($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Get-FleetIdentity([bool]$Runtime) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $sid = $identity.User.Value
    $interactive = @($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-4' }).Count -gt 0
    if ($identity.IsSystem -or $identity.IsAnonymous -or
        $sid -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20') -or
        !$interactive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
      throw 'Login startup requires the currently signed-in interactive Windows user.'
    }
    if ($Runtime -and ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw 'The login-start payload must not run elevated.'
    }
    return $sid
  } finally {
    $identity.Dispose()
  }
}

function Read-FleetManifest([string]$Path, [string]$Sid) {
  $value = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $suffix = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Sid)))).Replace('-', '').Substring(0, 12).ToLowerInvariant()
  } finally { $hash.Dispose() }
  $kindName = if ($value.kind -ceq 'host') { 'Host' } else { 'Node' }
  if ($value.schemaVersion -ne 1 -or $value.kind -cnotin @('host', 'node') -or
      $value.accountSid -cne $Sid -or $value.taskName -cne "CopilotFleet${kindName}Login-$suffix") {
    throw 'The login-start manifest does not belong to this Windows user.'
  }
  foreach ($field in @('repositoryPath', 'nodePath', 'runnerPath', 'controllerPath', 'logPath')) {
    $value.$field = Get-FleetFullPath $value.$field
  }
  return $value
}

function Get-FleetArguments($Config, [string]$ManifestPath, [string]$ResultPath) {
  $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File ' +
    (ConvertTo-FleetArgument $Config.controllerPath) + ' -Action run -Manifest ' +
    (ConvertTo-FleetArgument $ManifestPath)
  if ($ResultPath) { $arguments += ' -ProbeResult ' + (ConvertTo-FleetArgument $ResultPath) }
  return $arguments
}

function Get-FleetMarker($Config, [string]$ManifestPath, [string]$ResultPath) {
  return 'CopilotFleet login ' + ([ordered]@{
    schemaVersion = 1
    accountSid = $Config.accountSid
    manifestPath = $ManifestPath
    probeResult = $ResultPath
  } | ConvertTo-Json -Compress)
}

function New-FleetScheduler {
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  return $service
}

function Get-FleetTask($Folder, [string]$Name) {
  try { return $Folder.GetTask($Name) } catch {
    if ($_.Exception.GetBaseException().HResult -eq -2147024894) { return $null }
    throw
  }
}

function Test-FleetDuration([string]$Value, [int]$Seconds) {
  if (!$Value) { return $Seconds -eq 0 }
  return [Xml.XmlConvert]::ToTimeSpan($Value).TotalSeconds -eq $Seconds
}

function Get-FleetSettings([bool]$Probe) {
  return @{
    MultipleInstances = 2; DisallowStartIfOnBatteries = $false; StopIfGoingOnBatteries = $false
    StartWhenAvailable = $true; AllowHardTerminate = $true; AllowDemandStart = $true
    RunOnlyIfIdle = $false; RunOnlyIfNetworkAvailable = $false
    ExecutionTimeLimit = $(if ($Probe) { 'PT2M' } else { 'PT0S' })
    RestartInterval = $(if ($Probe) { '' } else { 'PT1M' })
    RestartCount = $(if ($Probe) { 0 } else { 10 })
  }
}

function Assert-FleetOwned($Task, $Config, [string]$ManifestPath, [string]$ResultPath) {
  $definition = $Task.Definition
  $principal = $definition.Principal
  $settings = $definition.Settings
  $probe = ![string]::IsNullOrEmpty($ResultPath)
  $valid = [string]::Equals($definition.RegistrationInfo.Description,
    (Get-FleetMarker $Config $ManifestPath $ResultPath), [StringComparison]::OrdinalIgnoreCase)
  $valid = $valid -and (Resolve-FleetSid $principal.UserId) -eq $Config.accountSid -and
    $principal.LogonType -eq 3 -and $principal.RunLevel -eq 0 -and $definition.Actions.Count -eq 1
  if ($definition.Actions.Count -eq 1) {
    $exec = $definition.Actions.Item(1)
    $valid = $valid -and $exec.Type -eq 0 -and (Test-FleetPath $exec.Path (Get-FleetPowerShell)) -and
      (Test-FleetPath $exec.WorkingDirectory $Config.repositoryPath) -and
      [string]::Equals($exec.Arguments, (Get-FleetArguments $Config $ManifestPath $ResultPath), [StringComparison]::OrdinalIgnoreCase)
  }
  foreach ($entry in (Get-FleetSettings $probe).GetEnumerator()) {
    if ($entry.Value -is [string]) {
      $seconds = if ($entry.Value) { [Xml.XmlConvert]::ToTimeSpan($entry.Value).TotalSeconds } else { 0 }
      $valid = $valid -and (Test-FleetDuration $settings.($entry.Key) $seconds)
    } else {
      $valid = $valid -and $settings.($entry.Key) -eq $entry.Value
    }
  }
  if ($probe) {
    $valid = $valid -and $definition.Triggers.Count -eq 0
  } else {
    $valid = $valid -and $definition.Triggers.Count -eq 1
    if ($definition.Triggers.Count -eq 1) {
      $trigger = $definition.Triggers.Item(1)
      $delay = if ($Config.kind -eq 'host') { 15 } else { 25 }
      $valid = $valid -and $trigger.Type -eq 9 -and $trigger.Enabled -and
        (Resolve-FleetSid $trigger.UserId) -eq $Config.accountSid -and
        (Test-FleetDuration $trigger.Delay $delay) -and
        !$trigger.StartBoundary -and !$trigger.EndBoundary -and
        (Test-FleetDuration $trigger.ExecutionTimeLimit 0) -and
        (Test-FleetDuration $trigger.Repetition.Interval 0) -and
        (Test-FleetDuration $trigger.Repetition.Duration 0)
    }
  }
  if (!$valid) { throw "Refusing foreign or modified task '$($Task.Name)'." }
}

function New-FleetDefinition($Service, $Config, [string]$ManifestPath, [string]$ResultPath) {
  $definition = $Service.NewTask(0)
  $definition.RegistrationInfo.Description = Get-FleetMarker $Config $ManifestPath $ResultPath
  $definition.Principal.UserId = $Config.accountSid
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  $settings = $definition.Settings
  $settings.Enabled = $true
  foreach ($entry in (Get-FleetSettings (![string]::IsNullOrEmpty($ResultPath))).GetEnumerator()) {
    if ($entry.Key -ne 'RestartInterval' -or $entry.Value) { $settings.($entry.Key) = $entry.Value }
  }
  if (!$ResultPath) {
    $trigger = $definition.Triggers.Create(9)
    $trigger.UserId = $Config.accountSid
    $trigger.Enabled = $true
    $trigger.ExecutionTimeLimit = 'PT0S'
    $trigger.Delay = if ($Config.kind -eq 'host') { 'PT15S' } else { 'PT25S' }
  }
  $exec = $definition.Actions.Create(0)
  $exec.Path = Get-FleetPowerShell
  $exec.Arguments = Get-FleetArguments $Config $ManifestPath $ResultPath
  $exec.WorkingDirectory = $Config.repositoryPath
  return $definition
}

function Get-FleetStatus($Task, [string]$Name) {
  if (!$Task) {
    return [ordered]@{ installed = $false; taskName = $Name; state = 'absent'; active = $false; lastTaskResult = $null }
  }
  return [ordered]@{
    installed = $true
    taskName = $Name
    state = @('unknown', 'disabled', 'queued', 'ready', 'running')[[int]$Task.State]
    active = [int]$Task.State -in @(2, 4)
    lastTaskResult = $Task.LastTaskResult
    accountSid = Resolve-FleetSid $Task.Definition.Principal.UserId
    logonType = $Task.Definition.Principal.LogonType
    runLevel = $Task.Definition.Principal.RunLevel
  }
}

function Get-FleetNow { return [DateTime]::UtcNow }

function Stop-FleetTask($Folder, $Task, $Config, [string]$ManifestPath, [string]$ResultPath) {
  Assert-FleetOwned $Task $Config $ManifestPath $ResultPath
  $wasActive = [int]$Task.State -in @(2, 4)
  $Task.Enabled = $false
  if ($wasActive -or [int]$Task.State -in @(2, 4)) { $Task.Stop(0) }
  $deadline = (Get-FleetNow).AddSeconds(10)
  do {
    $current = Get-FleetTask $Folder $Task.Name
    if (!$current) { throw 'The task disappeared while stopping it.' }
    Assert-FleetOwned $current $Config $ManifestPath $ResultPath
    if ([int]$current.State -notin @(2, 4)) { return $current }
    Start-Sleep -Milliseconds 200
  } while ((Get-FleetNow) -lt $deadline)
  throw 'The task did not stop within 10 seconds; it remains disabled.'
}

function Invoke-FleetProbe($Service, $Folder, $Config, [string]$ManifestPath, [string]$ResultPath) {
  if (!$ResultPath) { throw 'A fully qualified -ProbeResult path is required.' }
  $ResultPath = Get-FleetFullPath $ResultPath
  foreach ($protected in @($ManifestPath, $Config.repositoryPath, $Config.nodePath, $Config.runnerPath,
      $Config.controllerPath, $Config.logPath)) {
    if (Test-FleetPath $ResultPath $protected) { throw 'The probe result must not overwrite a manifest or runtime file.' }
  }
  $name = $Config.taskName + '-probe-' + [Guid]::NewGuid().ToString('N')
  $registered = $false
  $failure = $null
  try {
    if ([IO.File]::Exists($ResultPath)) { Remove-Item -LiteralPath $ResultPath }
    $definition = New-FleetDefinition $Service $Config $ManifestPath $ResultPath
    $task = $Folder.RegisterTaskDefinition($name, $definition, 2, $Config.accountSid, $null, 3, $null)
    $registered = $true
    Assert-FleetOwned $task $Config $ManifestPath $ResultPath
    $null = $task.Run($null)
    $started = Get-FleetNow
    $deadline = $started.AddSeconds(90)
    do {
      Start-Sleep -Milliseconds 250
      $task = Get-FleetTask $Folder $name
      if (!$task) { throw 'The probe task disappeared before completion.' }
      Assert-FleetOwned $task $Config $ManifestPath $ResultPath
      if ((Get-FleetNow) -ge $started.AddSeconds(2) -and [int]$task.State -notin @(2, 4) -and
          [IO.File]::Exists($ResultPath)) {
        $result = [IO.File]::ReadAllText($ResultPath) | ConvertFrom-Json
        if ($result.ok -isnot [bool]) { throw 'The probe produced an invalid result.' }
        if ($result.ok -and $task.LastTaskResult -ne 0) {
          throw "The probe reported success but its task failed (result $($task.LastTaskResult))."
        }
        return $result
      }
    } while ((Get-FleetNow) -lt $deadline)
    throw 'The same-user probe did not produce a result and finish within 90 seconds.'
  } catch {
    $failure = $_
    throw
  } finally {
    if ($registered) {
      try {
        $task = Get-FleetTask $Folder $name
        if ($task) {
          $null = Stop-FleetTask $Folder $task $Config $ManifestPath $ResultPath
          $Folder.DeleteTask($name, 0)
        }
      } catch {
        if (!$failure) { throw }
        [Console]::Error.WriteLine("Probe cleanup failed: $($_.Exception.Message)")
      }
    }
  }
}

function Write-FleetStartupError([string]$Message, [string]$LogPath) {
  [Console]::Error.WriteLine($Message)
  if ($LogPath) {
    try {
      [IO.File]::AppendAllText($LogPath, ([DateTime]::UtcNow.ToString('o') + ' ' + $Message + [Environment]::NewLine))
    } catch { [Console]::Error.WriteLine('Could not append the startup diagnostic to the runtime log.') }
  }
}

function Test-FleetInstallerBusy {
  # Windows Installer holds this mutex while an installation runs.
  $mutex = $null
  try { return [Threading.Mutex]::TryOpenExisting('Global\_MSIExecute', [ref]$mutex) }
  catch [UnauthorizedAccessException] { return $true } # It exists; this account cannot open it.
  finally { if ($mutex) { $mutex.Dispose() } }
}

function Wait-FleetInstaller($Config) {
  # Restart Manager stops node.exe before an installer replaces it. Starting
  # node.exe again before the installer finishes would lock it once more.
  Start-Sleep -Milliseconds 30000
  while ((Test-FleetInstallerBusy) -or ![IO.File]::Exists($Config.nodePath)) {
    Start-Sleep -Milliseconds 5000
  }
}

function Initialize-FleetLaunchJob {
  if ('FleetLaunchJob' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class FleetLaunchJob {
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  // Every process in this action's job, including those in nested jobs.
  static List<int> Members() {
    for (int capacity = 64; ; capacity *= 2) {
      int size = 8 + IntPtr.Size * capacity;
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        if (QueryInformationJobObject(IntPtr.Zero, 3, buffer, size, IntPtr.Zero)) {
          int listed = Marshal.ReadInt32(buffer, 4);
          var ids = new List<int>(listed);
          for (int i = 0; i < listed; i++)
            ids.Add((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
          return ids;
        }
        int error = Marshal.GetLastWin32Error();
        if (error != 234) throw new Win32Exception(error); // ERROR_MORE_DATA
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
  }

  // Ends what earlier launches left in this action's job, as closing the job
  // would, and reports whether only this process remains.
  public static bool EndOthers(int self, int milliseconds) {
    var deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
    while (true) {
      var others = Members();
      others.Remove(self);
      if (others.Count == 0) return true;
      if (DateTime.UtcNow >= deadline) return false;
      var opened = new List<KeyValuePair<int, IntPtr>>();
      foreach (int id in others) {
        IntPtr process = OpenProcess(0x0001, false, id); // PROCESS_TERMINATE
        if (process != IntPtr.Zero) opened.Add(new KeyValuePair<int, IntPtr>(id, process));
      }
      // An open handle keeps its PID from being reused, so a PID still listed
      // after opening it names the same job member.
      var current = Members();
      foreach (var entry in opened) {
        if (current.Contains(entry.Key)) TerminateProcess(entry.Value, 1);
        CloseHandle(entry.Value);
      }
      Thread.Sleep(100);
    }
  }
}
'@
}

function Clear-FleetLaunchJob {
  return [FleetLaunchJob]::EndOthers($PID, 10000)
}

function Invoke-FleetRun($Config, [string]$ManifestPath, [string]$ResultPath) {
  $helper = Join-Path ([IO.Path]::GetDirectoryName($Config.controllerPath)) 'windows-login-job.ps1'
  if (![IO.File]::Exists($helper)) { throw 'The login-start job guard is missing; reinstall login startup.' }
  $guardInfo = [Diagnostics.ProcessStartInfo]::new()
  $guardInfo.FileName = Get-FleetPowerShell
  $guardInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File ' +
    (ConvertTo-FleetArgument $helper) + ' -ParentProcessId ' + $PID
  $guardInfo.UseShellExecute = $false
  $guardInfo.CreateNoWindow = $true
  $guardInfo.RedirectStandardOutput = $true
  $guardInfo.RedirectStandardError = $true
  $guardInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
  $guardInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
  $guard = [Diagnostics.Process]::Start($guardInfo)
  $guardError = $guard.StandardError.ReadToEndAsync()
  $ready = $guard.StandardOutput.ReadLineAsync()
  if (!$ready.Wait(15000)) {
    # Only our own guard process is eligible for termination.
    if (!$guard.HasExited) { $guard.Kill() }
    throw 'The login-start job guard did not become ready within 15 seconds.'
  }
  if ($ready.Result -ne 'FLEET_JOB_READY' -or $guard.HasExited) {
    if (!$guard.HasExited) { $guard.Kill() }
    $detail = if ($guardError.Wait(2000)) { $guardError.Result.Trim() } else { 'Guard exited before readiness.' }
    throw "The login-start job guard failed: $detail"
  }
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $Config.nodePath
  $info.Arguments = (ConvertTo-FleetArgument $Config.runnerPath) + ' ' + (ConvertTo-FleetArgument $ManifestPath)
  if ($ResultPath) { $info.Arguments += ' --probe ' + (ConvertTo-FleetArgument (Get-FleetFullPath $ResultPath)) }
  $info.WorkingDirectory = $Config.repositoryPath
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardError = $true
  $diagnostic = [IO.FileStream]::new($Config.logPath + '.startup.log', [IO.FileMode]::Append,
    [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite, 1, [IO.FileOptions]::WriteThrough)
  try {
    if (!$ResultPath) { Initialize-FleetLaunchJob }
    $relaunches = [Collections.Generic.List[DateTime]]::new()
    while ($true) {
      if ($guard.HasExited) { throw 'The login-start job guard exited before Node could start.' }
      $child = [Diagnostics.Process]::Start($info)
      try {
        $stderr = $child.StandardError.BaseStream.CopyToAsync($diagnostic)
        $child.WaitForExit()
        $null = $stderr.Wait(2000)
        $code = $child.ExitCode
      } finally { $child.Dispose() }
      if ($ResultPath -or $code -notin @($FleetRelaunchExitCode, $FleetControlCExitCode)) { break }
      # Another program, such as an installer replacing node.exe, stopped the
      # runner. Task Scheduler restarts only a task that fails to launch, so
      # this action relaunches it, a bounded number of times, once nothing
      # from the stopped launch remains.
      $kind = $Config.kind
      $now = Get-FleetNow
      $recent = @($relaunches | Where-Object { $_ -gt $now.AddHours(-1) })
      if ($recent.Count -ge $FleetRelaunchLimitPerHour) {
        Write-FleetStartupError "[login-start] Other programs stopped $kind $($recent.Count + 1) times within an hour; not relaunching it. Start it with: npm run service -- $kind start" $Config.logPath
        return $code
      }
      if (!(Clear-FleetLaunchJob)) {
        Write-FleetStartupError "[login-start] Processes from the stopped $kind did not end; not relaunching it." $Config.logPath
        return $code
      }
      $relaunches.Add($now)
      Write-FleetStartupError "[login-start] Another program stopped $kind (exit $code); relaunching it once installers finish." $Config.logPath
      Wait-FleetInstaller $Config
    }
    if ($code -ne 0) {
      Write-FleetStartupError "Node runner exited with code $code; startup stderr: $($Config.logPath).startup.log." $Config.logPath
    }
    return $code
  } finally {
    $diagnostic.Dispose()
    # Do not stop the guard here: closing the action process kills its entire job.
    $guard.Dispose()
  }
}

function Invoke-FleetTask([string]$Operation, [string]$ManifestPath, [string]$ResultPath) {
  $sid = Get-FleetIdentity ($Operation -eq 'run')
  $ManifestPath = Get-FleetFullPath $ManifestPath
  $config = Read-FleetManifest $ManifestPath $sid
  if ($Operation -eq 'run') {
    $script:FleetStartupLog = $config.logPath
    return Invoke-FleetRun $config $ManifestPath $ResultPath
  }
  $service = New-FleetScheduler
  $folder = $service.GetFolder('\')
  if ($Operation -eq 'probe') { return Invoke-FleetProbe $service $folder $config $ManifestPath $ResultPath }
  $task = Get-FleetTask $folder $config.taskName
  if ($task) { Assert-FleetOwned $task $config $ManifestPath }
  if ($Operation -eq 'register') {
    if ($task -and [int]$task.State -in @(2, 4)) { throw 'Stop the existing login task before registering it.' }
    if (!$task) {
      $definition = New-FleetDefinition $service $config $ManifestPath
      $task = $folder.RegisterTaskDefinition($config.taskName, $definition, 2, $sid, $null, 3, $null)
      Assert-FleetOwned $task $config $ManifestPath
    }
    $task.Enabled = $true
  } elseif ($Operation -in @('stop', 'restart', 'uninstall') -and $task) {
    $task = Stop-FleetTask $folder $task $config $ManifestPath
    if ($Operation -eq 'uninstall') {
      $folder.DeleteTask($config.taskName, 0)
      $task = $null
    }
  }
  if ($Operation -in @('start', 'restart')) {
    if (!$task) { throw 'The login task is not installed.' }
    $task.Enabled = $true
    if ([int]$task.State -notin @(2, 4)) {
      $null = $task.Run($null)
      Start-Sleep -Milliseconds 2000
    }
    $task = Get-FleetTask $folder $config.taskName
    if (!$task) { throw 'The login task disappeared while starting.' }
    Assert-FleetOwned $task $config $ManifestPath
    if ([int]$task.State -notin @(2, 4)) {
      throw "The login task exited immediately (result $($task.LastTaskResult)); inspect $($config.logPath) and $($config.logPath).startup.log."
    }
  }
  return Get-FleetStatus $task $config.taskName
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    $result = Invoke-FleetTask $Action $Manifest $ProbeResult
    if ($Action -eq 'run') { exit ([int]$result) }
    $result | ConvertTo-Json -Compress -Depth 10
  } catch {
    $log = if ($Action -eq 'run') { $script:FleetStartupLog } else { $null }
    Write-FleetStartupError $_.Exception.Message $log
    exit 1
  }
}
