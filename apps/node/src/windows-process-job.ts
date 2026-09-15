import { randomUUID } from "node:crypto";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

// CREATE_SUSPENDED closes the spawn/assignment race. No breakaway is permitted:
// even a grandchild whose parent exits remains in the job until it is empty.
const native = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FleetJob {
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
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
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
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) {
    if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
  public static void Stop(string name) {
    var job = OpenJobObject(8, false, name);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try { Check(TerminateJobObject(job, 1)); } finally { CloseHandle(job); }
  }
  public static int Run(string name, string command, string proof) {
    var job = CreateJobObject(IntPtr.Zero, name);
    Check(job != IntPtr.Zero);
    var info = new ProcessInfo();
    bool assigned = false;
    try {
      var limits = new Limits();
      limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, without BREAKAWAY_OK.
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
      var startup = new Startup();
      startup.Size = (uint)Marshal.SizeOf(startup);
      startup.Flags = 0x100;
      startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      Check(SetHandleInformation(startup.Input, 1, 1));
      Check(SetHandleInformation(startup.Output, 1, 1));
      Check(SetHandleInformation(startup.Error, 1, 1));
      Check(CreateProcess(null, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
        true, 0x08000004, IntPtr.Zero, null, ref startup, out info));
      Check(AssignProcessToJobObject(job, info.Process));
      assigned = true;
      Check(ResumeThread(info.Thread) != 0xffffffff);
      Check(WaitForSingleObject(info.Process, 0xffffffff) == 0);
      uint code;
      Check(GetExitCodeProcess(info.Process, out code));
      Check(TerminateJobObject(job, 1));
      var deadline = DateTime.UtcNow.AddSeconds(10);
      Accounting accounting;
      do {
        Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (accounting.Active == 0) {
          Console.Error.WriteLine();
          Console.Error.WriteLine(proof);
          return unchecked((int)code);
        }
        System.Threading.Thread.Sleep(10);
      } while (DateTime.UtcNow < deadline);
      throw new Exception("Job process termination could not be verified.");
    } finally {
      if (!assigned && info.Process != IntPtr.Zero) {
        TerminateProcess(info.Process, 1);
        WaitForSingleObject(info.Process, 10000);
      }
      if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread);
      if (info.Process != IntPtr.Zero) CloseHandle(info.Process);
      CloseHandle(job);
    }
  }
}
`;

export function jobScript(body: string): string[] {
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${native}\n'@\n${body}`;
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function quote(argument: string): string {
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&")}"`;
}

export function spawnWindowsJob(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): { child: ChildProcessWithoutNullStreams; job: string; proof: string } {
  const job = `Local\\fleet-${randomUUID()}`;
  const proof = `fleet-process-tree-quiesced:${randomUUID()}`;
  let line = [command.replace(/^"(.*)"$/, "$1"), ...args].map(quote).join(" ");
  if (options.shell)
    line = `${quote(process.env.ComSpec ?? "cmd.exe")} /d /s /c "${line}"`;
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const child = spawn(
    "powershell.exe",
    jobScript(
      `exit ([FleetJob]::Run(${literal(job)},${literal(line)},${literal(proof)}))`,
    ),
    { ...options, shell: false, stdio: ["pipe", "pipe", "pipe"] },
  );
  return { child, job, proof };
}
