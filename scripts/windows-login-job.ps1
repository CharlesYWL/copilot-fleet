param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$ParentProcessId
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class FleetLoginJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimit {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations;
    public ulong ReadBytes, WriteBytes, OtherBytes;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimit {
    public BasicLimit Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit limits, int length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  public static void Guard(int processId) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr process = IntPtr.Zero;
    try {
      var limits = new ExtendedLimit();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      process = OpenProcess(0x100101, false, processId); // synchronize, set quota, terminate
      if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!AssignProcessToJobObject(job, process))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      Console.WriteLine("FLEET_JOB_READY");
      Console.Out.Flush();
      if (WaitForSingleObject(process, 0xffffffff) == 0xffffffff)
        throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      if (process != IntPtr.Zero) CloseHandle(process);
      CloseHandle(job);
    }
  }
}
'@
  [FleetLoginJob]::Guard($ParentProcessId)
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
