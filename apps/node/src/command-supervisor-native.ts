// Command-only supervisor. ACP deliberately keeps its existing lifetime semantics.
export const COMMAND_SUPERVISOR_ERROR_LIMIT = 2048;

export const commandSupervisorScript = String.raw`$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) {
  throw 'Windows PowerShell 5.1 is required.'
}
Add-Type -ReferencedAssemblies System.Web.Extensions -OutputAssembly (Join-Path $PSScriptRoot 'supervisor.exe') -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class FleetCommandSupervisor {
  public static int Main() {
    return Run(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "manifest.json"));
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr Minimum, Maximum; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits Basic; public Io Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread; public uint Pid, Tid;
  }
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
    public uint Size; public IntPtr Descriptor; public int Inherit;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta,
    bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool MoveFileEx(string oldName, string newName, uint flags);

  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static string DirectoryPath;
  static string Phase = "initializing";
  static Dictionary<string, object> Manifest, Identity;
  static readonly object OutputLock = new object();
  static long Retained;
  const long OutputLimit = 10 * 1024 * 1024;
  const int ErrorLimit = ${COMMAND_SUPERVISOR_ERROR_LIMIT};
  static string Bound(string message, int limit = ErrorLimit) {
    const string suffix = "...[truncated]";
    return message.Length <= limit ? message : message.Substring(0, limit - suffix.Length) + suffix;
  }
  static string ErrorDetail(Exception error) {
    var native = error as Win32Exception;
    return Bound(Phase + ": " + error.GetType().FullName + " (HRESULT=0x" +
      error.HResult.ToString("X8") + (native == null ? "" : ", Win32=" + native.NativeErrorCode) +
      "): " + error.Message);
  }
  static string WithSecondaryError(string original, Exception secondary) {
    string detail = ErrorDetail(secondary);
    return original == null ? detail : Bound(Bound(original, ErrorLimit / 2) + "\n" + detail);
  }
  static void Check(bool ok) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  static void Close(ref IntPtr handle) {
    if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
  }
  static string Text(Dictionary<string, object> value, string key) {
    return Convert.ToString(value[key], System.Globalization.CultureInfo.InvariantCulture);
  }
  static Dictionary<string, object> ProcessIdentity(IntPtr handle, uint pid) {
    long created, exited, kernel, user;
    Check(GetProcessTimes(handle, out created, out exited, out kernel, out user));
    return new Dictionary<string, object> { {"pid", pid}, {"creationTime", created.ToString()} };
  }
  static void WriteReceipt(string file, object value) {
    Phase = "write_" + file;
    string path = Path.Combine(DirectoryPath, file);
    string stage = path + ".writing";
    byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(value));
    using (var stream = new FileStream(stage, FileMode.Create, FileAccess.Write, FileShare.Read)) {
      stream.Write(bytes, 0, bytes.Length);
      stream.Flush(true);
    }
    Check(MoveFileEx(stage, path, 1 | 8)); // Atomic replacement, MOVEFILE_WRITE_THROUGH.
  }
  static bool Control(string file) {
    Phase = "read_" + file;
    string path = Path.Combine(DirectoryPath, file);
    Dictionary<string, object> value;
    try {
      // Atomic rename can publish a complete file before its publisher drops
      // transient write/delete access. Read-only sharing would reject that file.
      using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete)) {
        if (stream.Length > 65536) throw new InvalidDataException("Oversized control receipt.");
        using (var reader = new StreamReader(stream, Encoding.UTF8))
          value = Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
      }
    } catch (FileNotFoundException) { return false; }
    if (Text(value, "controlId") != Text(Manifest, "controlId") ||
        Text(value, "attemptId") != Text(Manifest, "attemptId") ||
        Text(value, "executionId") != Text(Manifest, "executionId"))
      throw new Exception("Control receipt identity mismatch.");
    return true;
  }
  static uint Active(IntPtr job) {
    Phase = "query_job";
    Accounting accounting;
    Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
    return accounting.Active;
  }
  static bool Empty(IntPtr job) {
    var wait = Stopwatch.StartNew();
    do {
      if (Active(job) == 0) return true;
      Thread.Sleep(10);
    } while (wait.ElapsedMilliseconds < 10000);
    return false;
  }
  static string Quote(string argument) {
    // Windows argv quoting; the shell sees only a short path, never script text.
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in argument) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      result.Append(c); slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  sealed class Drain {
    public long Bytes, Kept;
    public bool Failed;
    public Thread Worker;
    public Drain(IntPtr handle, string filename) {
      Worker = new Thread(delegate() {
        FileStream output = null;
        try {
          try { output = new FileStream(Path.Combine(DirectoryPath, filename), FileMode.CreateNew,
            FileAccess.Write, FileShare.ReadWrite | FileShare.Delete); }
          catch { Failed = true; }
          using (var input = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 65536, false)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) != 0) {
              Interlocked.Add(ref Bytes, count);
              int keep;
              lock (OutputLock) {
                keep = (int)Math.Min(count, OutputLimit - Retained);
                Retained += keep;
              }
              if (keep > 0 && output != null) {
                try {
                  output.Write(buffer, 0, keep);
                  output.Flush();
                  Interlocked.Add(ref Kept, keep);
                } catch { Failed = true; output.Dispose(); output = null; }
              }
            }
          }
        } catch { Failed = true; }
        finally { if (output != null) output.Dispose(); }
      });
      Worker.IsBackground = true;
      Worker.Start();
    }
    public object Summary() {
      long bytes = Interlocked.Read(ref Bytes), kept = Interlocked.Read(ref Kept);
      return new { bytes = bytes, retainedBytes = kept, droppedBytes = bytes - kept };
    }
  }
  public static int Run(string path) {
    DirectoryPath = Path.GetDirectoryName(path);
    Manifest = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
    Identity = new Dictionary<string, object> {
      {"version", 1}, {"executionId", Manifest["executionId"]}, {"attemptId", Manifest["attemptId"]},
      {"directory", DirectoryPath}, {"jobId", Manifest["jobId"]}, {"parent", Manifest["parent"]},
      {"supervisor", null}, {"root", null}, {"commandSha256", Manifest["commandSha256"]}
    };
    IntPtr job = IntPtr.Zero, parent = IntPtr.Zero, own = IntPtr.Zero;
    IntPtr stdinRead = IntPtr.Zero, stdinWrite = IntPtr.Zero;
    IntPtr stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero, stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero;
    var info = new ProcessInfo();
    bool assigned = false, started = false, quiescent = true, forced = false;
    object exitCode = null;
    string reason = "supervisor_error", error = null;
    Drain stdout = null, stderr = null;
    try {
      Phase = "inspect_supervisor";
      uint ownPid = (uint)Process.GetCurrentProcess().Id;
      own = OpenProcess(0x1000, false, ownPid); Check(own != IntPtr.Zero);
      Identity["supervisor"] = ProcessIdentity(own, ownPid);
      Phase = "inspect_parent";
      var expectedParent = (Dictionary<string, object>)Manifest["parent"];
      parent = OpenProcess(0x100000 | 0x1000, false, Convert.ToUInt32(expectedParent["pid"]));
      if (parent == IntPtr.Zero) { reason = "parent_lost"; return 0; }
      var parentIdentity = ProcessIdentity(parent, Convert.ToUInt32(expectedParent["pid"]));
      if (Text(parentIdentity, "creationTime") != Text(expectedParent, "creationTime") ||
          WaitForSingleObject(parent, 0) != 258) { reason = "parent_lost"; return 0; }

      Phase = "create_job";
      job = CreateJobObject(IntPtr.Zero, Text(Manifest, "jobId"));
      int jobError = Marshal.GetLastWin32Error();
      Check(job != IntPtr.Zero);
      if (jobError == 183) { Close(ref job); throw new Exception("Job identity already exists."); }
      var limits = new Limits();
      limits.Basic.Flags = 0x2000; // Noninherited handle; no BREAKAWAY flags.
      Phase = "configure_job";
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
      Phase = "create_pipes";
      var security = new SecurityAttributes();
      security.Size = (uint)Marshal.SizeOf(security); security.Inherit = 1;
      Check(CreatePipe(out stdinRead, out stdinWrite, ref security, 4096));
      Close(ref stdinWrite); // EOF from birth, including before the root is resumed.
      Check(CreatePipe(out stdoutRead, out stdoutWrite, ref security, 65536));
      Check(CreatePipe(out stderrRead, out stderrWrite, ref security, 65536));
      Check(SetHandleInformation(stdoutRead, 1, 0));
      Check(SetHandleInformation(stderrRead, 1, 0));
      var startup = new Startup();
      startup.Size = (uint)Marshal.SizeOf(startup); startup.Flags = 0x100;
      startup.Input = stdinRead; startup.Output = stdoutWrite; startup.Error = stderrWrite;
      string shell = Text(Manifest, "shellPath");
      string line = Quote(shell) + " -NoLogo -NoProfile -NonInteractive -File " +
        Quote(Path.Combine(DirectoryPath, "invoke.ps1"));
      if (line.Length >= 8191) throw new Exception("Generated shell command line is too long.");
      Phase = "create_root";
      Check(CreateProcess(shell, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true,
        0x08000004, IntPtr.Zero, Text(Manifest, "cwd"), ref startup, out info));
      quiescent = false;
      Phase = "assign_root";
      Check(AssignProcessToJobObject(job, info.Process));
      assigned = true;
      Phase = "inspect_root";
      Identity["root"] = ProcessIdentity(info.Process, info.Pid);
      Close(ref stdinRead); Close(ref stdoutWrite); Close(ref stderrWrite);
      Phase = "start_output_drains";
      stdout = new Drain(stdoutRead, "stdout.bin"); stdoutRead = IntPtr.Zero;
      stderr = new Drain(stderrRead, "stderr.bin"); stderrRead = IntPtr.Zero;

      // This receipt proves assignment while suspended, not merely a launcher spawn.
      WriteReceipt("ready.json", Identity);
      Phase = "parse_limits";
      var runtime = new Stopwatch();
      var controlRetry = new Stopwatch();
      long timeout = Convert.ToInt64(Manifest["timeoutMs"]);
      DateTime expiry = DateTime.Parse(Text(Manifest, "startExpiresAt"), null,
        System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();
      for (;;) {
        Phase = "wait_root";
        if (started && WaitForSingleObject(info.Process, 0) == 0) {
          Phase = "read_root_exit";
          uint code; Check(GetExitCodeProcess(info.Process, out code));
          exitCode = (long)code;
          forced = Active(job) > 0;
          reason = forced ? "descendant_cleanup" : "exited";
          break;
        }
        Phase = "wait_parent";
        if (WaitForSingleObject(parent, 0) != 258) { reason = "parent_lost"; break; }
        if (!started && DateTime.UtcNow >= expiry) { reason = "start_expired"; break; }
        if (started && runtime.ElapsedMilliseconds >= timeout) { reason = "timed_out"; break; }
        bool release = false;
        try {
          if (Control("cancel.json")) { reason = "cancelled"; break; }
          release = !started && Control("release.json");
          if (release && Control("cancel.json")) { reason = "cancelled"; break; }
          controlRetry.Reset();
        } catch (IOException e) {
          int code = e.HResult & 0xffff;
          if (code != 32 && code != 33) throw;
          if (!controlRetry.IsRunning) controlRetry.Start();
          if (controlRetry.ElapsedMilliseconds >= 1000) throw;
          // An unreadable cancellation is NOT absence or release authority.
          // Return to the parent/deadline checks instead of blocking this thread.
          Thread.Sleep(10);
          continue;
        }
        if (release) {
          if (WaitForSingleObject(parent, 0) != 258) { reason = "parent_lost"; break; }
          if (DateTime.UtcNow >= expiry) { reason = "start_expired"; break; }
          runtime.Start();
          Phase = "resume_root";
          Check(ResumeThread(info.Thread) != 0xffffffff);
          started = true;
          WriteReceipt("started.json", new { identity = Identity, startedAt = DateTime.UtcNow.ToString("o") });
        }
        Thread.Sleep(10);
      }
    } catch (Exception e) {
      error = ErrorDetail(e);
      reason = "supervisor_error";
    } finally {
      // Keep lifecycle persistence outside cleanup: output/disk failures must not skip termination.
      try {
        if (job != IntPtr.Zero) {
          Phase = "terminate_job";
          Check(TerminateJobObject(job, 1));
          quiescent = Empty(job);
        }
        if (!assigned && info.Process != IntPtr.Zero) {
          Phase = "terminate_unassigned_root";
          Check(TerminateProcess(info.Process, 1));
          quiescent = WaitForSingleObject(info.Process, 10000) == 0 && quiescent;
        }
      } catch (Exception e) { quiescent = false; error = WithSecondaryError(error, e); }
      Close(ref stdinRead); Close(ref stdinWrite);
      Close(ref stdoutRead); Close(ref stdoutWrite); Close(ref stderrRead); Close(ref stderrWrite);
      bool outputComplete = true;
      if (stdout != null && (!stdout.Worker.Join(10000) || stdout.Failed)) outputComplete = false;
      if (stderr != null && (!stderr.Worker.Join(10000) || stderr.Failed)) outputComplete = false;
      try {
        var result = new {
          exitCode = exitCode, reason = reason, descendantCleanupForced = forced,
          ownership = quiescent ? "quiescent" : "unknown",
          outcomeKnown = reason != "supervisor_error" && (reason != "parent_lost" || !started),
          interrupted = !quiescent || reason == "supervisor_error" || reason == "parent_lost" || forced,
          timedOut = reason == "timed_out", cancelled = reason == "cancelled", started = started,
          outputComplete = outputComplete, error = error, completedAt = DateTime.UtcNow.ToString("o"),
          stdout = stdout == null ? new { bytes = 0L, retainedBytes = 0L, droppedBytes = 0L } : stdout.Summary(),
          stderr = stderr == null ? new { bytes = 0L, retainedBytes = 0L, droppedBytes = 0L } : stderr.Summary()
        };
        if (quiescent) {
          // An independent proof survives loss of outcome evidence; never infer safety from a PID.
          WriteReceipt("quiescent.json", new { identity = Identity, quiescentAt = DateTime.UtcNow.ToString("o") });
        }
        WriteReceipt("terminal.json", new { identity = Identity, result = result });
      } catch (Exception e) {
        // The caller must quarantine missing receipts, even though closing our last job handle kills it.
        Console.Error.WriteLine(WithSecondaryError(error, e));
      }
      Close(ref info.Thread); Close(ref info.Process);
      Close(ref parent); Close(ref own); Close(ref job);
    }
    return 0;
  }
}
'@
`;
