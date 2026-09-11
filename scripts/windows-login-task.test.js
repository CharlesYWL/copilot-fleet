import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const controller = resolve("scripts", "windows-login-task.ps1");
const powershell = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const powershell7 = join(
  process.env.ProgramFiles || "C:\\Program Files",
  "PowerShell",
  "7",
  "pwsh.exe",
);
let scratch, directory, harness, manifest;
const shellArgs = (file, ...args) => [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-File",
  file,
  ...args,
];
const shellOptions = () => ({
  windowsHide: true,
  encoding: "utf8",
  stdio: "pipe",
  timeout: 30_000,
  env: { ...process.env, TEMP: scratch, TMP: scratch },
});

// Disconnected, unregistered TaskDefinitions supply native defaults without
// contacting Task Scheduler. Registration, execution, and deletion are mocked.
const harnessSource = String.raw`
param([string]$Scenario,[string]$Controller,[string]$Node)
$ErrorActionPreference='Stop'
. $Controller -Action status -Manifest (Join-Path $PSScriptRoot 'manifest.json')
$script:Clock=[DateTime]::UtcNow
$script:Events=[Collections.Generic.List[string]]::new()
$script:Registrations=[Collections.Generic.List[object]]::new()
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$script:Sid=$identity.User.Value
$script:Account=$identity.Name.Split('\')[-1]
$script:Definitions=New-Object -ComObject Schedule.Service
$script:Folder=[pscustomobject]@{Tasks=@{};ErrorCode=0;DeleteFailure=$false}
$script:ProbeStart=$null
$script:ProbePublishAt=1; $script:ProbeFinishAt=3; $script:ProbeExit=0; $script:ProbeOk=$true
$script:FailRun=$false; $script:ImmediateExit=$false
$script:ResultPath=Join-Path $PSScriptRoot 'probe.json'
$script:ManifestPath=Join-Path $PSScriptRoot 'manifest.json'
function Require($Condition,[string]$Message) { if (!$Condition) { throw $Message } }
function Get-Error($Work) { try { $null=& $Work; return $null } catch { return $_.Exception.Message } }
function Get-FleetIdentity([bool]$Runtime) { $script:Events.Add("identity:$Runtime"); return $script:Sid }
function New-FleetScheduler { return $script:Service }
function Get-FleetNow { return $script:Clock }
function Start-Sleep([int]$Milliseconds) {
  $script:Clock=$script:Clock.AddMilliseconds($Milliseconds)
  $script:Events.Add("sleep:$Milliseconds")
  if ($null -ne $script:ProbeStart) {
    $elapsed=($script:Clock-$script:ProbeStart).TotalSeconds
    if ($elapsed -ge $script:ProbePublishAt) {
      [IO.File]::WriteAllText($script:ResultPath,(@{ok=$script:ProbeOk;source='mock-runner';error='Sign in manually.'}|ConvertTo-Json))
    }
    if ($elapsed -ge $script:ProbeFinishAt) { $script:ProbeTask.State=3; $script:ProbeTask.LastTaskResult=$script:ProbeExit }
  }
}
$script:Folder | Add-Member ScriptMethod GetTask {
  param($name)
  if ($this.ErrorCode) { throw [Runtime.InteropServices.COMException]::new('scheduler lookup failed',$this.ErrorCode) }
  if (!$this.Tasks.ContainsKey($name)) { throw [Runtime.InteropServices.COMException]::new('not found',-2147024894) }
  return $this.Tasks[$name]
}
$script:Folder | Add-Member ScriptMethod RegisterTaskDefinition {
  param($name,$definition,$flags,$user,$password,$logon,$sddl)
  $script:Events.Add("register:$name")
  Require ($flags -eq 2 -and $user -eq $script:Sid -and $null -eq $password -and $logon -eq 3 -and $null -eq $sddl) 'Unsafe registration arguments'
  Require (!$this.Tasks.ContainsKey($name)) 'Registration attempted to replace a task'
  $script:Registrations.Add($name)
  $definition.Principal.UserId=$script:Account
  $task=[pscustomobject]@{Name=$name;Definition=$definition;State=3;LastTaskResult=0;Enabled=$true}
  $task | Add-Member ScriptMethod Run {
    param($parameters)
    $script:Events.Add("run:$($this.Name):enabled=$($this.Enabled)")
    if ($script:FailRun) { throw 'original start failure' }
    $this.State=4
    if ($script:ImmediateExit) { $this.State=3; $this.LastTaskResult=87 }
    if ($this.Name -like '*-probe-*') { $script:ProbeStart=$script:Clock; $script:ProbeTask=$this }
  }
  $task | Add-Member ScriptMethod Stop {
    param($flags)
    Require (!$this.Enabled -and $flags -eq 0) 'Stop must disable the task first'
    $script:Events.Add("stop:$($this.Name)")
    $this.State=1
  }
  $this.Tasks[$name]=$task
  return $task
}
$script:Folder | Add-Member ScriptMethod DeleteTask {
  param($name,$flags)
  Require (!$this.Tasks[$name].Enabled -and $flags -eq 0) 'Delete must disable the owned task first'
  $script:Events.Add("delete:$name")
  if ($this.DeleteFailure) { throw 'cleanup failure' }
  $this.Tasks.Remove($name)
}
$script:Service=[pscustomobject]@{}
$script:Service | Add-Member ScriptMethod NewTask { param($flags) return $script:Definitions.NewTask($flags) }
$script:Service | Add-Member ScriptMethod GetFolder { param($path) Require ($path -eq '\') 'Wrong task folder'; return $script:Folder }
$hash=[Security.Cryptography.SHA256]::Create()
$suffix=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:Sid)))).Replace('-','').Substring(0,12).ToLowerInvariant()
$hash.Dispose()
$kind=if($Scenario -eq 'node'){'node'}else{'host'}
$kindName=if($kind -eq 'host'){'Host'}else{'Node'}
$config=@{
  schemaVersion=1;kind=$kind;taskName="CopilotFleet$($kindName)Login-$suffix";accountSid=$script:Sid
  repositoryPath=$PSScriptRoot;nodePath=$Node;runnerPath=(Join-Path $PSScriptRoot 'fixture-runner.mjs')
  controllerPath=$Controller;logPath=(Join-Path $PSScriptRoot 'runtime.log');environment=@{};runtimeArgs=@()
}
$config|ConvertTo-Json|Set-Content -LiteralPath $script:ManifestPath -Encoding UTF8
function Invoke-Controller([string]$Operation) { return Invoke-FleetTask $Operation $script:ManifestPath $script:ResultPath }
function Event-Count([string]$Pattern) { return @($script:Events|Where-Object {$_ -like $Pattern}).Count }
switch ($Scenario) {
  {$_ -in @('host','node')} {
    $status=Invoke-Controller register
    $d=$script:Folder.Tasks[$config.taskName].Definition
    $delay=if($kind -eq 'host'){'PT15S'}else{'PT25S'}
    Require ($status.installed -and !$status.active -and $status.state -eq 'ready') 'Register started a workload'
    Require ($status.logonType -eq 3 -and $status.runLevel -eq 0 -and $status.accountSid -eq $script:Sid) 'Wrong principal'
    Require ($d.Principal.UserId -ne $script:Sid) 'Normalized native principal not exercised'
    Require ($d.Settings.ExecutionTimeLimit -eq 'PT0S' -and $d.Settings.RestartCount -eq 10 -and $d.Settings.RestartInterval -eq 'PT1M') 'Wrong recovery or execution limit'
    Require ($d.Settings.MultipleInstances -eq 2 -and !$d.Settings.DisallowStartIfOnBatteries -and !$d.Settings.StopIfGoingOnBatteries -and $d.Settings.StartWhenAvailable) 'Wrong workload settings'
    $trigger=$d.Triggers.Item(1)
    Require ($trigger.Type -eq 9 -and $trigger.Delay -eq $delay -and $trigger.Enabled -and $trigger.ExecutionTimeLimit -eq 'PT0S') 'Wrong logon trigger'
    $exec=$d.Actions.Item(1)
    $expected='-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$Controller+'" -Action run -Manifest "'+$script:ManifestPath+'"'
    Require ($exec.Path -eq (Get-FleetPowerShell) -and $exec.WorkingDirectory -eq $PSScriptRoot -and $exec.Arguments -eq $expected) 'Wrong action'
    Require ((Event-Count 'run:*') -eq 0 -and $d.RegistrationInfo.Description.Contains('"schemaVersion":1')) 'Missing marker or unexpected start'
  }
  'lifecycle' {
    Require (!(Invoke-Controller status).installed) 'Absent task reported installed'
    $null=Invoke-Controller register
    Require ((Invoke-Controller start).active) 'Start failed'
    Require ((Invoke-Controller stop).state -eq 'disabled') 'Stop did not disable'
    Require ((Invoke-Controller restart).active) 'Restart failed'
    Require (!(Invoke-Controller uninstall).installed) 'Uninstall left task registered'
    Require ($script:Folder.Tasks.Count -eq 0 -and (Event-Count 'run:*') -eq 2 -and (Event-Count 'stop:*') -eq 2 -and (Event-Count 'sleep:2000') -eq 2) 'Wrong lifecycle sequence'
    Require ([IO.File]::Exists($script:ManifestPath)) 'Uninstall removed user files'
  }
  'foreign' {
    $mutations=@{
      marker={param($d)$d.RegistrationInfo.Description='another owner'}
      principal={param($d)$d.Principal.UserId='S-1-5-19'}
      unresolved={param($d)$d.Principal.UserId='no-such-fleet-login-account-8a7655e4'}
      elevated={param($d)$d.Principal.RunLevel=1}
      service={param($d)$d.Principal.LogonType=5}
      executable={param($d)$d.Actions.Item(1).Path='C:\foreign.exe'}
      arguments={param($d)$d.Actions.Item(1).Arguments+=' -Command evil'}
      directory={param($d)$d.Actions.Item(1).WorkingDirectory='C:\foreign'}
      extraAction={param($d)$null=$d.Actions.Create(0)}
      triggerUser={param($d)$d.Triggers.Item(1).UserId='S-1-5-18'}
      triggerDelay={param($d)$d.Triggers.Item(1).Delay='PT1H'}
      extraTrigger={param($d)$null=$d.Triggers.Create(9)}
      timeBoundary={param($d)$d.Triggers.Item(1).EndBoundary='2027-01-01T00:00:00'}
      repetition={param($d)$d.Triggers.Item(1).Repetition.Interval='PT1M'}
      recovery={param($d)$d.Settings.RestartCount=3}
      timeLimit={param($d)$d.Settings.ExecutionTimeLimit='PT72H'}
      battery={param($d)$d.Settings.StopIfGoingOnBatteries=$true}
      demandStart={param($d)$d.Settings.AllowDemandStart=$false}
      idle={param($d)$d.Settings.RunOnlyIfIdle=$true}
      network={param($d)$d.Settings.RunOnlyIfNetworkAvailable=$true}
    }
    foreach($mutation in $mutations.GetEnumerator()){
      $script:Folder.Tasks.Clear();$null=Invoke-Controller register
      & $mutation.Value $script:Folder.Tasks[$config.taskName].Definition
      foreach($operation in @('status','register','start','stop','restart','uninstall')){
        $before=Event-Count '*'
        Require (Get-Error {Invoke-Controller $operation}) "Accepted foreign $($mutation.Key)/$operation"
        Require ((Event-Count '*') -eq $before+1) "Mutated foreign $($mutation.Key)/$operation"
      }
    }
  }
  'lookupErrors' {
    foreach($code in @(-2147024891,-2147216625)){
      $script:Folder.ErrorCode=$code
      foreach($operation in @('status','register','start','stop','restart','uninstall')){
        Require ((Get-Error {Invoke-Controller $operation}) -like '*scheduler lookup failed*') 'Swallowed scheduler error'
      }
    }
  }
  'repeatRegistration' {
    $null=Invoke-Controller register;$null=Invoke-Controller register;$null=Invoke-Controller start
    Require ($script:Registrations.Count -eq 1 -and (Get-Error {Invoke-Controller register}) -like '*Stop the existing login task*') 'Registration is not safe/idempotent'
  }
  'reenableRegistration' {
    $null=Invoke-Controller register;$null=Invoke-Controller stop;$null=Invoke-Controller register
    Require ($script:Folder.Tasks[$config.taskName].Enabled -and $script:Registrations.Count -eq 1 -and (Event-Count 'run:*') -eq 0) 'Reinstall did not reenable logon-only startup'
  }
  'repeatStart' {
    $null=Invoke-Controller register;$null=Invoke-Controller start
    Require ((Invoke-Controller start).active -and (Event-Count 'run:*') -eq 1 -and (Event-Count 'sleep:*') -eq 1) 'Duplicate start request'
  }
  'immediateExit' {
    $null=Invoke-Controller register;$script:ImmediateExit=$true
    $errorText=Get-Error {Invoke-Controller start}
    Require ($errorText -like '*result 87*' -and $errorText -like '*runtime.log.startup.log*' -and (Event-Count 'sleep:2000') -eq 1) 'Startup failure was hidden'
  }
  'disabledState' {
    $null=Invoke-Controller register;$null=Invoke-Controller start
    $script:Folder.Tasks[$config.taskName] | Add-Member ScriptProperty Enabled {return $this.State -ne 1} {param($value)if(!$value){$this.State=1}} -Force
    Require (!(Invoke-Controller stop).active -and (Event-Count 'stop:*') -eq 1) 'Disabled an active task without stopping it'
  }
  {$_ -like 'probe*'} {
    $script:Folder.Tasks['CopilotFleetNode']=[pscustomobject]@{untouched=$true}
    switch($Scenario){
      'probeOutputRace' {$script:ProbePublishAt=3;$script:ProbeFinishAt=1}
      'probeFailure' {$script:ProbeOk=$false;$script:ProbeExit=1}
      'probeExitFailure' {$script:ProbeExit=7}
      'probeTimeout' {$script:ProbeFinishAt=1000}
      'probeNoOutput' {$script:ProbePublishAt=1000}
      'probeCleanupFailure' {$script:FailRun=$true;$script:Folder.DeleteFailure=$true}
      'probeProtectedPath' {$script:ResultPath=$script:ManifestPath}
    }
    if($Scenario -ne 'probeProtectedPath'){[IO.File]::WriteAllText($script:ResultPath,'{"ok":true,"source":"stale"}')}
    $started=$script:Clock;$proof=$null;$failure=$null
    try{$proof=Invoke-Controller probe}catch{$failure=$_.Exception.Message}
    switch($Scenario){
      {$_ -in @('probe','probeOutputRace')} {
        Require (!$failure -and $proof.ok -and $proof.source -eq 'mock-runner' -and ($script:Clock-$started).TotalSeconds -eq 3) "Probe failed: $failure"
        $d=$script:ProbeTask.Definition
        Require ($d.Triggers.Count -eq 0 -and $d.Settings.RestartCount -eq 0 -and !$d.Settings.RestartInterval -and $d.Settings.ExecutionTimeLimit -eq 'PT2M') 'Unsafe probe definition'
        Require ($d.Actions.Item(1).Arguments.Contains('-ProbeResult "'+$script:ResultPath+'"')) 'Wrong probe arguments'
        Require ($script:Registrations[0] -match '^CopilotFleetHostLogin-[a-f0-9]{12}-probe-[a-f0-9]{32}$') 'Probe name is not isolated'
      }
      'probeFailure' {Require (!$proof.ok -and $proof.error -eq 'Sign in manually.') 'Auth failure lost'}
      {$_ -in @('probeTimeout','probeNoOutput')} {Require ($failure -like '*within 90 seconds*' -and ($script:Clock-$started).TotalSeconds -eq 90) 'Unbounded probe'}
      'probeExitFailure' {Require ($failure -like '*result 7*') 'Accepted failed probe exit'}
      'probeCleanupFailure' {Require ($failure -like '*original start failure*') 'Cleanup hid initial failure'}
      'probeProtectedPath' {Require ($failure -like '*must not overwrite*' -and $script:Registrations.Count -eq 0) 'Overwrote protected file'}
    }
    Require ($script:Folder.Tasks.ContainsKey('CopilotFleetNode')) 'Touched legacy task'
    if($Scenario -ne 'probeCleanupFailure'){Require ($script:Folder.Tasks.Count -eq 1) 'Leaked probe'}
    if($Scenario -eq 'probeTimeout'){Require ((Event-Count 'stop:*') -eq 1) 'Did not stop timed-out probe'}
  }
  'paths' {
    $null=Invoke-Controller register;$d=$script:Folder.Tasks[$config.taskName].Definition
    $d.Actions.Item(1).Path=$d.Actions.Item(1).Path.ToUpperInvariant()
    $d.Actions.Item(1).WorkingDirectory=$config.repositoryPath.ToUpperInvariant()+'\.'
    $d.Settings.ExecutionTimeLimit='';$d.Settings.RestartInterval='PT60S'
    Require ((Invoke-Controller status).installed -and (Get-FleetFullPath 'C:\') -eq 'C:\') 'Normalization/default mismatch'
    foreach($path in @('C:relative','\relative')){Require (Get-Error {Get-FleetFullPath $path}) 'Accepted relative path'}
    Require (Get-Error {Resolve-FleetSid 'no-such-fleet-login-account-8a7655e4'}) 'Accepted unknown account'
  }
  'quoting' {
    $values=@('','C:\space Ω O''Brien\','embedded"quote','slashes\\"quote','plain','$(not code); & nope')
    $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Node
    $info.Arguments=((@((Join-Path $PSScriptRoot 'echo-args.mjs'))+$values|ForEach-Object{ConvertTo-FleetArgument $_}) -join ' ')
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true
    $child=[Diagnostics.Process]::Start($info);$actual=$child.StandardOutput.ReadToEnd()|ConvertFrom-Json;$child.WaitForExit()
    Require ($child.ExitCode -eq 0 -and $actual.Count -eq $values.Count) 'Argument echo failed'
    $child.Dispose()
    for($i=0;$i -lt $values.Count;$i++){Require ($actual[$i] -ceq $values[$i]) "Argument $i changed"}
  }
  'identity' {
    . $Controller -Action status -Manifest $script:ManifestPath
    Require ((Get-FleetIdentity $false) -eq $script:Sid) 'Wrong native identity'
  }
  'manifestValidation' {
    $original=[IO.File]::ReadAllText($script:ManifestPath)
    foreach($field in @('accountSid','schemaVersion','taskName','controllerPath')){
      $invalid=$original|ConvertFrom-Json
      $invalid.$field=switch($field){'accountSid'{'S-1-5-19'}'schemaVersion'{2}'taskName'{'CopilotFleetNode'}'controllerPath'{'C:relative.ps1'}}
      $invalid|ConvertTo-Json|Set-Content -LiteralPath $script:ManifestPath -Encoding UTF8
      Require (Get-Error {Invoke-Controller register}) "Accepted invalid $field"
    }
    Require ($script:Registrations.Count -eq 0) 'Registered invalid manifest'
  }
  default {throw "Unknown scenario $Scenario"}
}
'OK'
`;

function run(scenario, engine = powershell) {
  return execFileSync(
    engine,
    shellArgs(
      harness,
      "-Scenario",
      scenario,
      "-Controller",
      controller,
      "-Node",
      process.execPath,
    ),
    shellOptions(),
  ).trim();
}

function failedAction(script = controller, ...extra) {
  try {
    execFileSync(
      powershell,
      shellArgs(script, "-Action", "run", "-Manifest", manifest, ...extra),
      shellOptions(),
    );
  } catch (error) {
    return error;
  }
  throw new Error("Expected action failure");
}

describe.skipIf(process.platform !== "win32")("Windows login task backend", () => {
  beforeAll(() => {
    scratch = mkdtempSync(resolve("scripts", ".login-test-"));
    directory = join(scratch, "Ω O'Brien");
    mkdirSync(directory);
    harness = join(directory, "scheduler-mock.ps1");
    manifest = join(directory, "manifest.json");
    writeFileSync(harness, `\uFEFF${harnessSource}`);
    writeFileSync(
      join(directory, "echo-args.mjs"),
      "console.log(JSON.stringify(process.argv.slice(2)));",
    );
  });
  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it.each([
    ["host", "passwordless Host definition"],
    ["node", "passwordless Node definition"],
    ["lifecycle", "start/disable/stop/restart/uninstall"],
    ["foreign", "20 foreign mutations across all six operations"],
    ["lookupErrors", "propagated COM errors"],
    ["repeatRegistration", "safe repeated registration"],
    ["reenableRegistration", "reenabled installation"],
    ["repeatStart", "idempotent start"],
    ["immediateExit", "immediate startup failure"],
    ["disabledState", "disabled-but-active stop"],
    ["probe", "probe completion"],
    ["probeOutputRace", "probe output race"],
    ["probeFailure", "authentication refusal"],
    ["probeTimeout", "running probe timeout"],
    ["probeNoOutput", "missing probe output"],
    ["probeExitFailure", "failing probe exit"],
    ["probeCleanupFailure", "original error retained"],
    ["probeProtectedPath", "protected manifest"],
    ["paths", "native defaults and path normalization"],
    ["quoting", "literal Win32 arguments"],
    ["identity", "native current-user SID"],
    ["manifestValidation", "foreign manifest refusal"],
  ])("%s: %s", (scenario) => expect(run(scenario)).toBe("OK"));

  it.skipIf(!existsSync(powershell7))("supports PowerShell 7", () => {
    for (const scenario of ["host", "lifecycle", "paths"])
      expect(run(scenario, powershell7)).toBe("OK");
  });

  it("preserves probe arguments and startup error diagnostics", () => {
    run("host");
    const resultPath = join(directory, "run probe Ω's.json");
    writeFileSync(
      join(directory, "fixture-runner.mjs"),
      `
      import {writeFileSync} from "node:fs";
      writeFileSync(process.argv[4],JSON.stringify(process.argv.slice(2)));
      console.error("fixture failure before runtime logger");process.exitCode=23;`,
    );
    const failure = failedAction(controller, "-ProbeResult", resultPath);
    expect(failure.status, failure.stderr?.toString()).toBe(23);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual([
      manifest,
      "--probe",
      resultPath,
    ]);
    expect(readFileSync(join(directory, "runtime.log.startup.log"), "utf8")).toContain(
      "fixture failure before runtime logger",
    );
    expect(readFileSync(join(directory, "runtime.log"), "utf8")).toContain(
      "Node runner exited with code 23; startup stderr:",
    );
  }, 30_000);

  it("refuses to launch without a working job guard", () => {
    run("host");
    const isolated = join(directory, "guard-failure");
    mkdirSync(isolated);
    const script = join(isolated, "windows-login-task.ps1");
    writeFileSync(script, readFileSync(controller));
    writeFileSync(
      join(isolated, "windows-login-job.ps1"),
      "[Console]::Error.WriteLine('fixture guard failed');exit 9",
    );
    const config = JSON.parse(readFileSync(manifest, "utf8").replace(/^\uFEFF/, ""));
    writeFileSync(manifest, JSON.stringify({ ...config, controllerPath: script }));
    const marker = join(isolated, "must-not-start");
    writeFileSync(
      join(directory, "fixture-runner.mjs"),
      `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},"started");`,
    );
    const failure = failedAction(script);
    expect(failure.status).toBe(1);
    expect(failure.stderr.toString()).toContain("fixture guard failed");
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(config.logPath, "utf8")).toContain("fixture guard failed");
  }, 30_000);

  it("kills the owned process tree when its action exits", async () => {
    run("host");
    const pidFile = join(directory, "owned-processes.json");
    writeFileSync(
      join(directory, "fixture-runner.mjs"),
      `
      import {spawn} from "node:child_process";import {writeFileSync} from "node:fs";
      const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{windowsHide:true,stdio:"ignore"});
      writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({runner:process.pid,descendant:child.pid,action:process.ppid}));
      console.error("fixture startup diagnostic");setInterval(()=>{},1000);`,
    );
    const action = spawn(
      powershell,
      shellArgs(controller, "-Action", "run", "-Manifest", manifest),
      {
        ...shellOptions(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let diagnostic = "";
    action.stderr.on("data", (chunk) => {
      diagnostic += chunk;
    });
    let owned;
    try {
      for (let i = 0; i < 200 && !existsSync(pidFile) && action.exitCode === null; i++)
        await setTimeout(100);
      expect(existsSync(pidFile), diagnostic).toBe(true);
      owned = JSON.parse(readFileSync(pidFile, "utf8"));
      expect(owned.action).toBe(action.pid);
      expect(alive(owned.runner) && alive(owned.descendant)).toBe(true);
      const startupLog = join(directory, "runtime.log.startup.log");
      for (
        let i = 0;
        i < 50 &&
        !readFileSync(startupLog, "utf8").includes("fixture startup diagnostic");
        i++
      )
        await setTimeout(100);
      action.kill();
      for (let i = 0; i < 100 && (alive(owned.runner) || alive(owned.descendant)); i++)
        await setTimeout(100);
      expect(alive(owned.runner) || alive(owned.descendant)).toBe(false);
      expect(readFileSync(startupLog, "utf8")).toContain("fixture startup diagnostic");
    } finally {
      if (action.exitCode === null) action.kill();
      for (const pid of [owned?.runner, owned?.descendant])
        if (pid && alive(pid)) process.kill(pid);
    }
  }, 40_000);
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
