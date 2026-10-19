import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { join, win32 } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { securePrivateDirectory } from "./data-permissions.js";
import {
  CorpDirectMaterialSchema,
  PrivateIpv4Schema,
  type CorpDirectMaterial,
} from "@fleet/protocol";
export { CorpDirectMaterialSchema, type CorpDirectMaterial } from "@fleet/protocol";

// Private bundles cross the process boundary only through an explicitly
// restricted temporary directory. Never emit keys on PowerShell output streams,
// where enterprise transcription/module logging could record them.
const certificateScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Web.Extensions
$serializer=[Web.Script.Serialization.JavaScriptSerializer]::new()
$inputData=$serializer.DeserializeObject([Console]::In.ReadToEnd())
$ca=$null; $caKey=$null; $serverKey=$null; $leaf=$null; $unsignedLeaf=$null
try {
  $hash=[Security.Cryptography.HashAlgorithmName]::SHA256
  $padding=[Security.Cryptography.RSASignaturePadding]::Pkcs1
  $flags=[Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  if ($inputData.authorityFile) {
    $ca=[Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String([IO.File]::ReadAllText($inputData.authorityFile)),'',$flags)
    if (-not $ca.HasPrivateKey -or $ca.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow.AddDays(30)) { throw 'The existing certificate authority cannot issue a server certificate.' }
  } else {
    $caKey=[Security.Cryptography.RSACng]::new(3072)
    $caRequest=[Security.Cryptography.X509Certificates.CertificateRequest]::new(('CN=Copilot Fleet '+$inputData.hostId+' private CA'),$caKey,$hash,$padding)
    $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
    $caUsage=[Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
    $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($caUsage,$true))
    $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey,$false))
    $ca=$caRequest.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddYears(10))
  }
  $serverKey=[Security.Cryptography.RSACng]::new(2048)
  $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new(('CN='+$inputData.hostIp),$serverKey,$hash,$padding)
  $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddIpAddress([Net.IPAddress]::Parse($inputData.hostIp))
  $request.CertificateExtensions.Add($san.Build())
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
  $usage=[Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage,$true))
  $purposes=[Security.Cryptography.OidCollection]::new()
  [void]$purposes.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($purposes,$false))
  $serial=New-Object byte[] 16
  $random=[Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($serial) } finally { $random.Dispose() }
  $expires=[DateTimeOffset]::UtcNow.AddYears(1)
  if ($expires.UtcDateTime -ge $ca.NotAfter.ToUniversalTime()) { $expires=[DateTimeOffset]::new($ca.NotAfter.ToUniversalTime()).AddDays(-1) }
  $unsignedLeaf=$request.Create($ca,[DateTimeOffset]::UtcNow.AddMinutes(-5),$expires,$serial)
  $leaf=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($unsignedLeaf,$serverKey)
  $pem="-----BEGIN CERTIFICATE-----"+[Environment]::NewLine+[Convert]::ToBase64String($ca.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert),[Base64FormattingOptions]::InsertLineBreaks)+[Environment]::NewLine+"-----END CERTIFICATE-----"
  $bundle=@{authorityPfx=[Convert]::ToBase64String($ca.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,''));caCertificate=$pem;serverPfx=[Convert]::ToBase64String($leaf.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,''));serverExpiresAt=$leaf.NotAfter.ToUniversalTime().ToString('o');caExpiresAt=$ca.NotAfter.ToUniversalTime().ToString('o')}
  [IO.File]::WriteAllText($inputData.outputFile,$serializer.Serialize($bundle),[Text.UTF8Encoding]::new($false))
} catch { [Console]::Error.WriteLine('Native certificate generation failed.'); exit 1 }
finally { foreach($item in @($leaf,$unsignedLeaf,$serverKey,$ca,$caKey)){if($null -ne $item){$item.Dispose()}} }
`;

export const issueCorpDirectCertificates = async (
  hostId: string,
  hostIp: string,
  existing?: CorpDirectMaterial,
): Promise<CorpDirectMaterial> => {
  if (process.platform !== "win32")
    throw new Error("Automatic Corp direct certificates require Windows.");
  PrivateIpv4Schema.parse(hostIp);
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(hostId))
    throw new Error("Invalid Host identity for certificate generation.");
  if (existing && existing.hostId !== hostId)
    throw new Error("The Corp direct authority belongs to a different Host identity.");
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !win32.isAbsolute(systemRoot))
    throw new Error(
      "An absolute SystemRoot is required for native certificate generation.",
    );
  const executable = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const stagingRoot = tmpdir();
  if (!/^[a-z]:[\\/]/i.test(stagingRoot))
    throw new Error(
      "Corp direct certificate staging requires a local Windows temporary directory, not a UNC share.",
    );
  const directory = await mkdtemp(join(stagingRoot, "fleet-corp-certificates-"));
  let output: string;
  try {
    await securePrivateDirectory(directory);
    const authorityFile = join(directory, "authority.private");
    const outputFile = join(directory, "bundle.private");
    if (existing)
      await writeFile(authorityFile, existing.authorityPfx, { mode: 0o600, flag: "wx" });
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        executable,
        ["-NoProfile", "-NonInteractive", "-Command", certificateScript],
        { windowsHide: true, timeout: 60000, maxBuffer: 512 * 1024 },
        (error) => {
          if (error) {
            reject(
              new Error(
                "Corp direct certificate creation failed. Check Windows certificate API availability and the existing CA's expiry; private error output was withheld.",
              ),
            );
            return;
          }
          resolve();
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(
        JSON.stringify({
          hostId,
          hostIp,
          outputFile,
          ...(existing ? { authorityFile } : {}),
        }),
      );
    });
    output = await readFile(outputFile, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  let material: CorpDirectMaterial;
  try {
    material = CorpDirectMaterialSchema.parse({ ...JSON.parse(output), hostId, hostIp });
  } catch {
    throw new Error(
      "The Windows certificate helper returned an invalid certificate bundle.",
    );
  }
  const authority = new X509Certificate(material.caCertificate);
  if (!authority.ca || !authority.verify(authority.publicKey))
    throw new Error("The Corp direct authority is not a valid self-signed CA.");
  if (
    existing &&
    authority.fingerprint256 !==
      new X509Certificate(existing.caCertificate).fingerprint256
  )
    throw new Error("Refused to replace the existing Corp direct trust authority.");
  return material;
};
