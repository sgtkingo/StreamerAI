// Build with scripts/distribution/setup-windows.mjs. No services are changed until Install is clicked.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using ServiceController = System.ServiceProcess.ServiceController;
using ServiceControllerStatus = System.ServiceProcess.ServiceControllerStatus;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Xml;

internal sealed class SetupConfiguration {
    public string version { get; set; }
    public bool reviewOnly { get; set; }
    public bool preview { get; set; }
    public string payloadSha256 { get; set; }
    public long payloadBytes { get; set; }
    public long payloadUnpackedBytes { get; set; }
    public string ollamaUrl { get; set; }
    public string ollamaSha256 { get; set; }
    public long ollamaBytes { get; set; }
}

internal sealed class SetupFailure : Exception {
    internal readonly string Code;
    internal SetupFailure(string code, string message) : base(message) { Code = code; }
}

internal static class Program {
    internal const string Model = "qwen3.5:4b";
    internal const string ServerUrl = "https://localhost:8443";
    // The first preview's Caddyfile omitted quotes around paths under Program Files.
    private const string BrokenGatewaySha256 = "f9049eabb41ccb266f2da9fc34ca70b7f324dc2ff45648bbbe7903a70eed9d06";
    private const string RepairedGatewaySha256 = "63e03e52e23de7cde4037b770ca4355177c3670524270c9ad432d784779464a0";
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    internal static SetupConfiguration Configuration;
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint serverProcessId);

    [STAThread]
    private static int Main(string[] args) {
        try {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("setup-config.json"))
            using (StreamReader reader = new StreamReader(resource)) Configuration = Json.Deserialize<SetupConfiguration>(reader.ReadToEnd());
            if (args.Contains("--self-test")) {
                VerifyPayload();
                VerifyGatewayRepair();
                var exact = Json.Deserialize<Dictionary<string, object>>("{\"models\":[{\"name\":\"qwen3.5:4b\"}]}");
                var other = Json.Deserialize<Dictionary<string, object>>("{\"models\":[{\"name\":\"qwen3.5:4b-other\",\"description\":\"qwen3.5:4b\"}]}");
                if (!HasModel(exact) || HasModel(other)) throw new InvalidDataException("Exact model matching check failed.");
                foreach (bool directory in new[] { false, true }) foreach (bool privateState in new[] { false, true }) {
                    FileSystemSecurity security = ManagedSecurity(directory, privateState);
                    if (!security.AreAccessRulesProtected || security.GetOwner(typeof(SecurityIdentifier)).Value != "S-1-5-32-544") throw new InvalidDataException("Protected creation ACL check failed.");
                    foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
                        if (rule.IdentityReference.Value == "S-1-5-32-545" && (privateState || rule.FileSystemRights != (FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize))) throw new InvalidDataException("Public program access must be read-only.");
                    }
                }
                if (!NeedsBootstrap(Json.Deserialize<Dictionary<string, object>>("{\"enabled\":true,\"claimed\":false}")) || NeedsBootstrap(Json.Deserialize<Dictionary<string, object>>("{\"enabled\":true,\"claimed\":true}")) || NeedsBootstrap(Json.Deserialize<Dictionary<string, object>>("{\"enabled\":false,\"claimed\":false}"))) throw new InvalidDataException("Owner handoff policy check failed.");
                try { NeedsBootstrap(Json.Deserialize<Dictionary<string, object>>("{\"enabled\":\"false\",\"claimed\":false}")); throw new InvalidOperationException("Malformed owner status was accepted."); } catch (InvalidDataException) { }
                Console.WriteLine(Json.Serialize(new { format = "streamerai-setup/v1", version = Configuration.version, reviewOnly = Configuration.reviewOnly, preview = Configuration.preview, payloadVerified = true, gatewayRepairVerified = true, exactModelMatchVerified = true, protectedCreationVerified = true, ownerHandoffVerified = true, serverUrl = ServerUrl, recommendedModel = Model }));
                return 0;
            }
            if (args.Contains("--render-preview") || args.Contains("--preview-image")) {
                Application.EnableVisualStyles();
                using (SetupWindow window = new SetupWindow(false))
                using (Bitmap bitmap = new Bitmap(window.Width, window.Height)) {
                    if (args.Contains("--preview-state")) window.ShowPreviewResult(Argument(args, "--preview-state"));
                    PreparePreviewHandles(window);
                    window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                    bitmap.Save(Argument(args, args.Contains("--preview-image") ? "--preview-image" : "--render-preview"), System.Drawing.Imaging.ImageFormat.Png);
                }
                return 0;
            }
            if (args.Contains("--check-managed-state")) {
                AssertManagedState(Argument(args, "--check-managed-state"));
                Console.WriteLine("Managed state access checks passed.");
                return 0;
            }
            if (args.Contains("--elevated")) return Elevated(args);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupWindow(args.Contains("--configure-ai")));
            return 0;
        } catch (Exception exception) {
            if (args.Contains("--self-test") || args.Contains("--check-managed-state")) Console.Error.WriteLine(exception.GetType().Name + ": " + exception.Message);
            else MessageBox.Show("Setup could not continue. " + exception.Message, "StreamerAI Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    internal static string Quote(string value) {
        // Windows process argument quoting; no shell interpolation.
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
    internal static string FailureCode(Exception error) {
        SetupFailure known = error as SetupFailure;
        if (known != null) return known.Code;
        if (error is UnauthorizedAccessException) return "ACCESS_DENIED";
        if (error is TimeoutException) return "SETUP_TIMEOUT";
        if (error is InvalidDataException) return "INVALID_INSTALLATION_DATA";
        return "SERVER_SETUP_FAILED";
    }
    private static void PreparePreviewHandles(Control control) {
        // Hidden Forms do not create child native handles via CreateControl alone.
        // Accessing Handle creates them without Show/Shown, so no probe or installation runs.
        IntPtr handle = control.Handle;
        control.PerformLayout();
        foreach (Control child in control.Controls) PreparePreviewHandles(child);
        control.PerformLayout();
    }
    private static readonly string[] ManagedStateAccounts = { "S-1-5-18", "S-1-5-32-544", "S-1-5-19" };
    private static FileSystemSecurity ManagedSecurity(bool directory, bool privateState) {
        FileSystemSecurity security = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(new SecurityIdentifier("S-1-5-32-544"));
        foreach (string sid in new[] { "S-1-5-18", "S-1-5-32-544", "S-1-5-19", "S-1-5-32-545" }) {
            if (privateState && sid == "S-1-5-32-545") continue;
            FileSystemRights rights = sid == "S-1-5-18" || sid == "S-1-5-32-544" ? FileSystemRights.FullControl : privateState ? FileSystemRights.Modify : FileSystemRights.ReadAndExecute;
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), rights, directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
        }
        return security;
    }
    private static void CreateManagedDirectory(string directory, bool privateState) {
        // Pass the protected ACL at creation, before a filtered administrator token
        // could inherit an individual-owner WRITE_DAC grant from a parent directory.
        Directory.CreateDirectory(directory, (DirectorySecurity)ManagedSecurity(true, privateState));
        AssertManagedPath(directory, privateState);
    }
    private static void CreatePayloadDirectories(string root, string directory) {
        string relative = Path.GetFullPath(directory).Substring(Path.GetFullPath(root).Length).TrimStart(Path.DirectorySeparatorChar);
        string current = root;
        foreach (string part in relative.Split(new[] { Path.DirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)) {
            current = Path.Combine(current, part); CreateManagedDirectory(current, false);
        }
    }
    private static FileStream CreateManagedFile(string filename, bool privateState, FileMode mode) {
        return new FileStream(filename, mode, FileSystemRights.Write, FileShare.None, 65536, FileOptions.None, (FileSecurity)ManagedSecurity(false, privateState));
    }
    private static void WriteManagedText(string filename, string contents) {
        AssertManagedPath(filename, true);
        using (FileStream file = CreateManagedFile(filename, true, FileMode.Create))
        using (StreamWriter writer = new StreamWriter(file, new UTF8Encoding(false))) writer.Write(contents);
    }
    private static void AssertManagedPath(string filename, bool privateState) {
        FileAttributes attributes;
        try { attributes = File.GetAttributes(filename); }
        catch (FileNotFoundException) { return; }
        catch (DirectoryNotFoundException) { return; }
        if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Managed server paths must not contain reparse points.");
        AccessControlSections sections = AccessControlSections.Access | AccessControlSections.Owner;
        FileSystemSecurity security = (attributes & FileAttributes.Directory) != 0
            ? (FileSystemSecurity)Directory.GetAccessControl(filename, sections)
            : File.GetAccessControl(filename, sections);
        string owner = security.GetOwner(typeof(SecurityIdentifier)).Value;
        string[] trusted = privateState ? ManagedStateAccounts : new[] { "S-1-5-18", "S-1-5-32-544" };
        if (!trusted.Contains(owner)) throw new InvalidDataException("Managed server paths are not owned by trusted managed accounts.");
        FileSystemRights writes = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteExtendedAttributes | FileSystemRights.WriteAttributes | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
            if (rule.AccessControlType == AccessControlType.Allow && !trusted.Contains(rule.IdentityReference.Value) && (privateState || (rule.FileSystemRights & writes) != 0))
                throw new InvalidDataException("Managed server paths grant access outside trusted managed accounts.");
        }
    }
    private static void AssertManagedDescendant(string root, string relative, bool privateState) {
        string current = Path.GetFullPath(root);
        AssertManagedPath(current, privateState);
        foreach (string part in relative.Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries)) {
            if (part == "." || part == ".." || part.Contains(":")) throw new InvalidDataException("Invalid managed server path.");
            current = Path.Combine(current, part); AssertManagedPath(current, privateState);
        }
    }
    private static void AssertManagedState(string state) {
        // ProgramData itself uses normal OS ACLs; only this private subtree is scoped here.
        foreach (string relative in new[] { "", "setup-receipt.json", "data/installation-bootstrap.key", "keys/master.key", "gateway/pki/authorities/local/root.crt" }) AssertManagedDescendant(state, relative, true);
    }
    internal static string Hash(Stream stream) {
        using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    internal static void VerifyPayload() {
        using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("server.zip")) {
            if (payload == null || payload.Length != Configuration.payloadBytes || Hash(payload) != Configuration.payloadSha256)
                throw new InvalidDataException("The embedded server package is damaged.");
        }
    }
    private static void VerifyGatewayRepair() {
        using (Stream template = Assembly.GetExecutingAssembly().GetManifestResourceStream("gateway-repair.caddyfile"))
            if (template == null || Hash(template) != RepairedGatewaySha256) throw new InvalidDataException("The HTTPS gateway repair is damaged.");
    }
    private static string NodeText(XmlDocument document, string xpath) {
        XmlNode node = document.SelectSingleNode(xpath);
        if (node == null) throw new InvalidDataException("The installed HTTPS gateway service definition is incomplete.");
        return node.InnerText;
    }
    private static void RepairPreviousGateway(string program, string state, string release, Action<string> progress) {
        string installedConfig = Path.Combine(release, "service", "Caddyfile");
        AssertManagedDescendant(program, "releases/" + Configuration.version + "/service/Caddyfile", false);
        string installedHash;
        using (FileStream file = File.OpenRead(installedConfig)) installedHash = Hash(file);
        if (installedHash != BrokenGatewaySha256) return;
        VerifyGatewayRepair();
        string serviceRelative = "services/Gateway/StreamerAIGateway.xml";
        AssertManagedDescendant(program, serviceRelative, false);
        string serviceFile = Path.Combine(program, "services", "Gateway", "StreamerAIGateway.xml");
        XmlDocument xml = new XmlDocument { XmlResolver = null };
        using (XmlReader reader = XmlReader.Create(serviceFile, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null })) xml.Load(reader);
        string oldArguments = "run --config " + Quote(installedConfig) + " --adapter caddyfile";
        string repairFile = Path.Combine(state, "gateway", "repair.Caddyfile");
        string repairedArguments = "run --config " + Quote(repairFile) + " --adapter caddyfile";
        string arguments = NodeText(xml, "/service/arguments");
        if (NodeText(xml, "/service/id") != "StreamerAIGateway" ||
            !NodeText(xml, "/service/executable").Equals(Path.Combine(release, "bin", "caddy.exe"), StringComparison.OrdinalIgnoreCase) ||
            NodeText(xml, "/service/serviceaccount/domain") != "NT AUTHORITY" ||
            NodeText(xml, "/service/serviceaccount/user") != "LocalService" ||
            NodeText(xml, "/service/env[@name='STREAMERAI_STATE_ROOT']/@value") != state ||
            NodeText(xml, "/service/env[@name='STREAMERAI_RELEASE_ROOT']/@value") != release ||
            (arguments != oldArguments && arguments != repairedArguments))
            throw new InvalidDataException("The installed HTTPS gateway definition differs from the known preview; automatic repair was not applied.");
        progress("Repairing the previous HTTPS gateway setup…");
        AssertManagedDescendant(state, "gateway/repair.Caddyfile", true);
        if (!File.Exists(repairFile)) {
            using (Stream template = Assembly.GetExecutingAssembly().GetManifestResourceStream("gateway-repair.caddyfile"))
            using (FileStream target = CreateManagedFile(repairFile, true, FileMode.CreateNew)) template.CopyTo(target);
        }
        using (FileStream existing = File.OpenRead(repairFile))
            if (Hash(existing) != RepairedGatewaySha256) throw new InvalidDataException("An existing HTTPS gateway repair file differs from the verified template.");
        if (arguments != repairedArguments) {
            xml.SelectSingleNode("/service/arguments").InnerText = repairedArguments;
            string temporary = serviceFile + ".repair-" + Guid.NewGuid().ToString("N");
            try {
                using (FileStream file = CreateManagedFile(temporary, false, FileMode.CreateNew)) xml.Save(file);
                AssertManagedDescendant(program, serviceRelative, false);
                File.Replace(temporary, serviceFile, null);
            } finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        using (ServiceController gateway = new ServiceController("StreamerAIGateway")) {
            gateway.Refresh();
            if (gateway.Status == ServiceControllerStatus.StopPending) gateway.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
            gateway.Refresh();
            if (gateway.Status == ServiceControllerStatus.Stopped) {
                gateway.Start();
                gateway.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));
            } else if (gateway.Status != ServiceControllerStatus.Running)
                throw new InvalidOperationException("The HTTPS gateway is in an unexpected service state.");
        }
    }
    private static string ExtractPayload() {
        VerifyPayload();
        // Elevated payloads must not execute from a user-writable TEMP directory.
        string temporary = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "StreamerAI.SetupStaging-" + Guid.NewGuid().ToString("N"));
        CreateManagedDirectory(temporary, false);
        string root = Path.GetFullPath(temporary) + Path.DirectorySeparatorChar;
        try {
        using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("server.zip"))
        using (ZipArchive archive = new ZipArchive(payload, ZipArchiveMode.Read)) {
            if (archive.Entries.Count > 50000) throw new InvalidDataException("Server package has too many entries.");
            long total = 0;
            HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (ZipArchiveEntry entry in archive.Entries) {
                total += entry.Length;
                string destination = Path.GetFullPath(Path.Combine(temporary, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                if (!destination.StartsWith(root, StringComparison.OrdinalIgnoreCase) || entry.FullName.Contains(":") || !names.Add(destination) || total > 8L * 1024 * 1024 * 1024)
                    throw new InvalidDataException("The server package has unsafe paths or size.");
                if (entry.Name.Length == 0) CreatePayloadDirectories(temporary, destination);
                else {
                    CreatePayloadDirectories(temporary, Path.GetDirectoryName(destination));
                    using (Stream source = entry.Open())
                    using (FileStream target = CreateManagedFile(destination, false, FileMode.CreateNew)) source.CopyTo(target);
                }
            }
        }
        string[] candidates = Directory.GetFiles(temporary, "bundle.json", SearchOption.AllDirectories);
        if (candidates.Length != 1) throw new InvalidDataException("The package must contain exactly one server bundle.");
        return Path.GetDirectoryName(candidates[0]);
        } catch { try { CleanupExtracted(temporary); } catch { } throw; }
    }
    private static void CleanupExtracted(string release) {
        if (release == null) return;
        string root = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)) + Path.DirectorySeparatorChar;
        string candidate = Path.GetFullPath(release);
        // Only our per-run extraction root may be removed; never walk arbitrary paths.
        while (candidate.StartsWith(root, StringComparison.OrdinalIgnoreCase) && !Path.GetFileName(candidate).StartsWith("StreamerAI.SetupStaging-", StringComparison.Ordinal)) {
            string parent = Path.GetDirectoryName(candidate);
            if (parent == null || parent == candidate) return;
            candidate = parent;
        }
        if (candidate.StartsWith(root, StringComparison.OrdinalIgnoreCase) && Path.GetFileName(candidate).StartsWith("StreamerAI.SetupStaging-", StringComparison.Ordinal)) Directory.Delete(candidate, true);
    }
    private static string Argument(string[] args, string name) {
        int index = Array.IndexOf(args, name);
        if (index < 0 || index + 1 >= args.Length) throw new ArgumentException("A setup control argument is missing.");
        return args[index + 1];
    }
    private static int Elevated(string[] args) {
        if (Configuration.reviewOnly) throw new InvalidOperationException("This review build cannot install services.");
        string pipeName = Argument(args, "--pipe");
        int parentId;
        Guid parsedPipe;
        if (!Guid.TryParseExact(pipeName, "N", out parsedPipe) || !Int32.TryParse(Argument(args, "--parent"), out parentId)) throw new ArgumentException("Invalid setup process identity.");
        using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.None)) {
            pipe.Connect(30000);
            uint actualParent;
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out actualParent) || actualParent != (uint)parentId) throw new InvalidOperationException("Setup process identity could not be verified.");
            using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true }) {
                Action<string> progress = value => writer.WriteLine(Json.Serialize(new { kind = "progress", message = value }));
                string release = null;
                try {
                    using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) throw new InvalidOperationException("Administrator permission was not granted.");
                    progress("Verifying and preparing the server package…");
                    string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "StreamerAI");
                    string receipt = Path.Combine(state, "setup-receipt.json");
                    AssertManagedState(state);
                    bool resume = false;
                    if (File.Exists(receipt)) {
                        var saved = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(receipt));
                        resume = saved.ContainsKey("version") && Convert.ToString(saved["version"]) == Configuration.version && saved.ContainsKey("phase") && Convert.ToString(saved["phase"]) == "services-installed";
                    }
                    string installedRelease = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "StreamerAI", "releases", Configuration.version);
                    if (resume) {
                        string program = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "StreamerAI");
                        foreach (string relative in new[] { "releases/" + Configuration.version + "/runtime/node.exe", "releases/" + Configuration.version + "/service/verify-bundle.mjs", "releases/" + Configuration.version + "/bundle.json", "setup/StreamerAI-Setup.exe" }) AssertManagedDescendant(program, relative, false);
                    }
                    release = resume ? installedRelease : ExtractPayload();
                    string node = Path.Combine(release, "runtime", "node.exe");
                    Run(node, Quote(Path.Combine(release, "service", "verify-bundle.mjs")) + " " + Quote(release) + " --complete", release, 120000);
                    if (!resume) {
                        progress("Installing the StreamerAI services and protected data directory…");
                        string powerShell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
                        Run(powerShell, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(Path.Combine(release, "service", "install-windows.ps1")) + " -Apply -AllowPrototype", release, 180000);
                        WriteManagedText(receipt, Json.Serialize(new { version = Configuration.version, phase = "services-installed" }));
                    } else {
                        progress("Completing the previous local server setup…");
                        RepairPreviousGateway(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "StreamerAI"), state, release, progress);
                    }
                    string certificateFile = Path.Combine(state, "gateway", "pki", "authorities", "local", "root.crt");
                    progress("Preparing trusted local HTTPS for this computer…");
                    try { WaitForFile(certificateFile, 60000); }
                    catch (TimeoutException) {
                        using (ServiceController gateway = new ServiceController("StreamerAIGateway")) {
                            gateway.Refresh();
                            throw new SetupFailure("GATEWAY_CERTIFICATE_TIMEOUT", "The HTTPS gateway did not create its certificate (service: " + gateway.Status + "). Check the StreamerAIGateway service log and retry setup. Existing data was preserved.");
                        }
                    }
                    AssertManagedState(state);
                    bool needsBootstrap;
                    using (X509Certificate2 certificate = new X509Certificate2(certificateFile)) {
                        bool isCa = certificate.Extensions.OfType<X509BasicConstraintsExtension>().Any(extension => extension.CertificateAuthority);
                        if (!isCa || certificate.HasPrivateKey) throw new InvalidDataException("The local HTTPS certificate is not a public CA certificate.");
                        using (X509Store store = new X509Store(StoreName.Root, StoreLocation.LocalMachine)) { store.Open(OpenFlags.ReadWrite); store.Add(certificate); }
                        progress("Checking the server through its own trusted HTTPS certificate…");
                        WaitForTrustedServer(certificate.Thumbprint);
                        needsBootstrap = NeedsBootstrap(ReadTrustedServerJson("/api/v1/installation/status", certificate.Thumbprint));
                    }
                    progress("Creating Start menu shortcuts…");
                    string setupDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "StreamerAI", "setup");
                    CreateManagedDirectory(setupDirectory, false);
                    string retainedSetup = Path.Combine(setupDirectory, "StreamerAI-Setup.exe");
                    if (!Path.GetFullPath(Assembly.GetExecutingAssembly().Location).Equals(Path.GetFullPath(retainedSetup), StringComparison.OrdinalIgnoreCase)) {
                        AssertManagedPath(retainedSetup, false);
                        using (FileStream source = File.OpenRead(Assembly.GetExecutingAssembly().Location))
                        using (FileStream destination = CreateManagedFile(retainedSetup, false, resume ? FileMode.Create : FileMode.CreateNew)) source.CopyTo(destination);
                    }
                    string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), "StreamerAI");
                    Directory.CreateDirectory(menu);
                    File.WriteAllText(Path.Combine(menu, "Open StreamerAI.url"), "[InternetShortcut]\r\nURL=" + ServerUrl + "\r\n", Encoding.ASCII);
                    Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                    object shell = Activator.CreateInstance(shellType);
                    object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { Path.Combine(menu, "Configure local AI.lnk") });
                    shortcut.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { retainedSetup });
                    shortcut.GetType().InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { "--configure-ai" });
                    shortcut.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, new object[0]);
                    string token = null;
                    if (needsBootstrap) {
                        string bootstrap = Path.Combine(state, "data", "installation-bootstrap.key");
                        WaitForFile(bootstrap, 60000);
                        AssertManagedState(state);
                        token = File.ReadAllText(bootstrap).Trim();
                        if (!System.Text.RegularExpressions.Regex.IsMatch(token, "^[a-f0-9]{64}$")) throw new InvalidDataException("The owner setup key is invalid.");
                    }
                    WriteManagedText(receipt, Json.Serialize(new { version = Configuration.version, phase = "complete" }));
                    writer.WriteLine(Json.Serialize(new { kind = "installed", bootstrap = token }));
                    return 0;
                } catch (Exception exception) {
                    writer.WriteLine(Json.Serialize(new { kind = "error", code = FailureCode(exception), message = exception.Message }));
                    return 1;
                } finally {
                    try { CleanupExtracted(release); } catch { /* the OS temp directory may be cleaned later */ }
                }
            }
        }
    }
    internal static void Run(string executable, string arguments, string directory, int timeout) {
        using (Process process = Process.Start(new ProcessStartInfo(executable, arguments) { WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true })) {
            Task<string> output = process.StandardOutput.ReadToEndAsync();
            Task<string> error = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(timeout)) throw new TimeoutException("An installation step did not finish in time. Check the service status before retrying.");
            Task.WaitAll(output, error);
            if (process.ExitCode != 0) throw new InvalidOperationException("An installation step failed. " + Truncate(error.Result.Length > 0 ? error.Result : output.Result, 500));
        }
    }
    internal static string Truncate(string value, int maximum) { return value.Length <= maximum ? value : value.Substring(0, maximum); }
    internal static void WaitForFile(string filename, int milliseconds) {
        DateTime until = DateTime.UtcNow.AddMilliseconds(milliseconds);
        while (!File.Exists(filename) && DateTime.UtcNow < until) Thread.Sleep(500);
        if (!File.Exists(filename)) throw new TimeoutException("The server did not become ready. Your existing data has been preserved.");
    }
    private static void WaitForTrustedServer(string rootThumbprint) {
        DateTime until = DateTime.UtcNow.AddSeconds(60);
        for (;;) {
            try {
                var result = ReadTrustedServerJson("/api/v1/health/ready", rootThumbprint); object status;
                if (result.TryGetValue("status", out status) && Convert.ToString(status) == "ready") return;
            } catch { }
            if (DateTime.UtcNow >= until) throw new SetupFailure("HTTPS_READINESS_FAILED", "The server is not ready through its own HTTPS certificate. Check local port conflicts, then retry setup.");
            Thread.Sleep(1000);
        }
    }
    private static IDictionary<string, object> ReadTrustedServerJson(string path, string rootThumbprint) {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(ServerUrl + path);
        request.Proxy = null; request.Timeout = 5000; request.ReadWriteTimeout = 5000; request.AllowAutoRedirect = false;
        request.ServerCertificateValidationCallback = (sender, certificate, chain, errors) => errors == System.Net.Security.SslPolicyErrors.None && chain != null && chain.ChainElements.Count > 0 && chain.ChainElements[chain.ChainElements.Count - 1].Certificate.Thumbprint.Equals(rootThumbprint, StringComparison.OrdinalIgnoreCase);
        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
        using (StreamReader reader = new StreamReader(response.GetResponseStream())) {
            char[] buffer = new char[65536]; int length = reader.ReadBlock(buffer, 0, buffer.Length);
            if (response.StatusCode != HttpStatusCode.OK || length == buffer.Length || reader.Read() != -1) throw new InvalidDataException("The local server status response is invalid or too large.");
            var result = Json.Deserialize<Dictionary<string, object>>(new string(buffer, 0, length));
            if (result == null) throw new InvalidDataException("The local server status response is invalid.");
            return result;
        }
    }
    private static bool NeedsBootstrap(IDictionary<string, object> status) {
        object enabled, claimed;
        if (!status.TryGetValue("enabled", out enabled) || !(enabled is bool) || !status.TryGetValue("claimed", out claimed) || !(claimed is bool)) throw new InvalidDataException("The server owner status must contain valid boolean fields.");
        return (bool)enabled && !(bool)claimed;
    }
    internal static IDictionary<string, object> ReadJson(string url, int timeout) {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.Proxy = null; request.Timeout = timeout; request.ReadWriteTimeout = timeout; request.AllowAutoRedirect = false;
        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
        using (StreamReader reader = new StreamReader(response.GetResponseStream())) {
            char[] buffer = new char[1024 * 1024]; int length = reader.ReadBlock(buffer, 0, buffer.Length);
            if (length == buffer.Length || reader.Read() != -1) throw new InvalidDataException("The local AI response is too large.");
            return Json.Deserialize<Dictionary<string, object>>(new string(buffer, 0, length));
        }
    }
    internal static bool OllamaReady() {
        var info = ReadJson("http://127.0.0.1:11434/api/version", 3000);
        object version;
        return info.TryGetValue("version", out version) && version is string && System.Text.RegularExpressions.Regex.IsMatch((string)version, "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[a-zA-Z0-9.+-]*)$");
    }
    internal static bool HasModel(IDictionary<string, object> tags) {
        object raw;
        if (!tags.TryGetValue("models", out raw)) return false;
        var models = raw as System.Collections.IEnumerable;
        if (models == null || raw is string) return false;
        foreach (object item in models) {
            var model = item as IDictionary<string, object>; object name, identifier;
            if (model != null && ((model.TryGetValue("name", out name) && Convert.ToString(name) == Model) || (model.TryGetValue("model", out identifier) && Convert.ToString(identifier) == Model))) return true;
        }
        return false;
    }
}

internal sealed class SetupWindow : Form {
    private readonly bool configureOnly;
    private readonly Label title = new Label();
    private readonly Label summary = new Label();
    private readonly Label privacy = new Label();
    private readonly Label status = new Label();
    private readonly Label aiStatus = new Label();
    private readonly Label runtimeNotice = new Label();
    private readonly Label modelNotice = new Label();
    private readonly CheckBox installAi = new CheckBox();
    private readonly CheckBox downloadModel = new CheckBox();
    private readonly Button install = new Button();
    private readonly Button cancel = new Button();
    private readonly ProgressBar progress = new ProgressBar();
    private readonly Panel result = new Panel();
    private readonly Label resultSymbol = new Label();
    private readonly Label resultTitle = new Label();
    private readonly Label resultSummary = new Label();
    private readonly TextBox resultDetails = new TextBox();
    private bool working, installed, aiAvailable, modelAvailable, aiFailed, skipRequested;
    private string bootstrap;
    private CancellationTokenSource aiCancellation;

    internal SetupWindow(bool configureOnly) {
        this.configureOnly = configureOnly;
        Text = configureOnly ? "StreamerAI — Configure local AI" : "StreamerAI Server Setup" + (Program.Configuration.preview ? " — Preview" : "");
        ClientSize = new Size(650, 520); MinimumSize = new Size(666, 559); StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(20, 21, 29); ForeColor = Color.FromArgb(242, 238, 231); Font = new Font("Segoe UI", 10);
        Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
        Label brand = new Label { Text = "STREAMER", Font = new Font("Segoe UI", 13, FontStyle.Bold), ForeColor = Color.FromArgb(229, 9, 20), AutoSize = true, Location = new Point(30, 25) };
        Label brandAi = new Label { Text = "AI", Font = new Font("Segoe UI", 13, FontStyle.Bold), ForeColor = Color.White, AutoSize = true, Location = new Point(127, 25) };
        title.Text = configureOnly ? "Local AI, ready when you need it." : "Your home cinema starts here."; title.Font = new Font("Segoe UI", 23, FontStyle.Regular); title.AutoSize = true; title.Location = new Point(28, 60);
        summary.Text = configureOnly ? "Existing Ollama installations and models will be reused. Downloads need your choice below." : "Setup prepares the server, its background services, protected storage and trusted local HTTPS. Your other devices only need a web browser."; summary.Location = new Point(30, 112); summary.Size = new Size(585, 58);
        aiStatus.Location = new Point(30, 180); aiStatus.Size = new Size(585, 35); aiStatus.Text = "Checking local AI…";
        installAi.Text = "Install Ollama if it is missing (optional download, about 1.7 GB)"; installAi.Location = new Point(30, 220); installAi.Size = new Size(585, 32);
        downloadModel.Text = "Download the recommended Qwen 3.5 4B model if missing (about 3.4 GB)"; downloadModel.Location = new Point(30, 255); downloadModel.Size = new Size(585, 43);
        foreach (CheckBox option in new[] { installAi, downloadModel }) { option.ForeColor = ForeColor; option.BackColor = BackColor; }
        runtimeNotice.Location = installAi.Location; runtimeNotice.Size = installAi.Size; runtimeNotice.ForeColor = Color.FromArgb(213, 219, 225);
        modelNotice.Location = downloadModel.Location; modelNotice.Size = downloadModel.Size; modelNotice.ForeColor = Color.FromArgb(213, 219, 225);
        privacy.Text = "AI stays on this computer. You can continue without it and add it later. Downloads use the official Ollama distribution; service access is configured in the browser."; privacy.Location = new Point(30, 305); privacy.Size = new Size(585, 50); privacy.ForeColor = Color.FromArgb(190, 194, 204);
        progress.Location = new Point(30, 370); progress.Size = new Size(585, 15); progress.Visible = false;
        status.Location = new Point(30, 395); status.Size = new Size(585, 50);
        install.Location = new Point(380, 460); install.Size = new Size(235, 35); install.Text = configureOnly ? "Prepare local AI" : Program.Configuration.preview ? "Install StreamerAI preview" : "Install StreamerAI";
        install.BackColor = Color.FromArgb(229, 9, 20); install.ForeColor = Color.White; install.FlatStyle = FlatStyle.Flat;
        cancel.Location = new Point(250, 460); cancel.Size = new Size(115, 35); cancel.Text = "Close";
        cancel.Click += (sender, args) => { if (working && aiCancellation != null) { skipRequested = true; aiCancellation.Cancel(); } else { if (installed && aiFailed) OpenBrowser(); Close(); } }; install.Click += async (sender, args) => await InstallClicked();
        result.Location = new Point(30, 95); result.Size = new Size(585, 340); result.BackColor = Color.FromArgb(28, 30, 39); result.Visible = false;
        resultSymbol.Location = new Point(22, 20); resultSymbol.Size = new Size(55, 52); resultSymbol.Font = new Font("Segoe UI Symbol", 29, FontStyle.Bold);
        resultTitle.Location = new Point(83, 25); resultTitle.Size = new Size(475, 48); resultTitle.Font = new Font("Segoe UI", 20, FontStyle.Bold);
        resultSummary.Location = new Point(24, 93); resultSummary.Size = new Size(535, 78); resultSummary.Font = new Font("Segoe UI", 11);
        Label detailsTitle = new Label { Text = "INSTALLATION RESULT", Location = new Point(24, 190), Size = new Size(535, 24), Font = new Font("Segoe UI", 9, FontStyle.Bold), ForeColor = Color.FromArgb(190, 194, 204) };
        resultDetails.Location = new Point(24, 218); resultDetails.Size = new Size(535, 95); resultDetails.Multiline = true; resultDetails.ReadOnly = true; resultDetails.ScrollBars = ScrollBars.Vertical; resultDetails.BorderStyle = BorderStyle.FixedSingle; resultDetails.BackColor = Color.FromArgb(18, 20, 27); resultDetails.ForeColor = Color.FromArgb(230, 232, 237); resultDetails.Font = new Font("Consolas", 9);
        result.Controls.AddRange(new Control[] { resultSymbol, resultTitle, resultSummary, detailsTitle, resultDetails });
        Controls.AddRange(new Control[] { brand, brandAi, title, summary, aiStatus, installAi, runtimeNotice, downloadModel, modelNotice, privacy, progress, status, result, install, cancel });
        installAi.CheckedChanged += (sender, args) => UpdateOptions();
        install.Enabled = false;
        Shown += async (sender, args) => { await DetectAi(); if (!Program.Configuration.reviewOnly && !working) install.Enabled = true; };
        FormClosing += (sender, args) => { if (working) { args.Cancel = true; SetStatus("Please wait for setup to finish before closing this window."); } };
        if (Program.Configuration.reviewOnly) {
            install.Enabled = false; installAi.Enabled = false; downloadModel.Enabled = false;
            install.BackColor = Color.FromArgb(74, 77, 88);
            status.Text = "Review build: the embedded runtime is incomplete. Installation is disabled; no services or AI components can be installed by this build.";
        }
        UpdateOptions();
    }
    private void SetStatus(string message) { if (IsHandleCreated) BeginInvoke((Action)(() => status.Text = Program.Truncate(message, 350))); }
    private void UpdateOptions() {
        bool runtimeChoice = !Program.Configuration.reviewOnly && !aiAvailable && (File.Exists(ExistingOllama()) || !String.IsNullOrEmpty(Program.Configuration.ollamaSha256));
        installAi.Visible = runtimeChoice;
        runtimeNotice.Visible = !runtimeChoice;
        runtimeNotice.Text = aiAvailable ? "✓ Ollama is already available — the existing installation will be used" : Program.Configuration.reviewOnly ? "Local AI options are unavailable in this review build" : "Automatic Ollama setup is unavailable in this build";
        bool modelChoice = !Program.Configuration.reviewOnly && !modelAvailable && (aiAvailable || installAi.Checked);
        downloadModel.Visible = modelChoice;
        modelNotice.Visible = !modelChoice;
        modelNotice.Text = modelAvailable ? "✓ Recommended model is already installed — no download needed" : Program.Configuration.reviewOnly ? "Model download is unavailable in this review build" : "Select Ollama above to enable the model download";
    }
    private static string HumanFailure(string code, bool serverReady) {
        if (serverReady) return "Your server is ready, but local AI setup needs another try. You can still open StreamerAI now; your existing models are safe.";
        if (code == "GATEWAY_CERTIFICATE_TIMEOUT") return "The secure web gateway did not start. Your existing server data and access keys are safe. Retry setup after checking the gateway service.";
        if (code == "HTTPS_READINESS_FAILED") return "The server did not answer over secure HTTPS. Check whether another application uses local port 8443, then retry.";
        if (code == "ACCESS_DENIED") return "Windows did not grant access to finish setup. Retry and approve the administrator prompt.";
        return "The server could not finish setup. Your existing data was preserved. You can retry without reinstalling everything.";
    }
    private void ShowResult(bool success, string code, string message, string detail) {
        foreach (Control control in new Control[] { title, summary, aiStatus, installAi, runtimeNotice, downloadModel, modelNotice, privacy, progress, status }) control.Visible = false;
        resultSymbol.Text = success ? "✓" : "☹";
        resultSymbol.ForeColor = success ? Color.FromArgb(110, 226, 166) : Color.FromArgb(249, 119, 125);
        resultTitle.Text = success ? "Ready to watch." : "Setup needs another try.";
        resultSummary.Text = message;
        resultDetails.Text = "STATUS: " + (success ? "OK" : "ERROR") + "\r\nCODE: " + code + "\r\n" + Program.Truncate(detail.Replace('\r', ' ').Replace('\n', ' '), 600);
        resultDetails.ScrollBars = detail.Length > 180 ? ScrollBars.Vertical : ScrollBars.None;
        result.Visible = true;
        install.Text = success ? "Open StreamerAI" : installed || configureOnly ? "Retry local AI setup" : "Retry installation";
        cancel.Text = !success && installed ? "Open StreamerAI" : "Close";
    }
    private void ShowSetup() {
        result.Visible = false;
        foreach (Control control in new Control[] { title, summary, aiStatus, privacy, progress, status }) control.Visible = true;
        UpdateOptions();
    }
    internal void ShowPreviewResult(string state) {
        install.Enabled = true;
        install.BackColor = Color.FromArgb(229, 9, 20);
        if (state == "success") { installed = true; ShowResult(true, "SERVER_READY", "StreamerAI is installed and ready. Continue in your web browser; existing profiles and models were preserved.", "Local address: " + Program.ServerUrl); }
        else if (state == "error") ShowResult(false, "GATEWAY_CERTIFICATE_TIMEOUT", HumanFailure("GATEWAY_CERTIFICATE_TIMEOUT", false), "DETAIL: The HTTPS gateway did not create its certificate. Existing data was preserved.");
        else if (state == "options") {
            aiStatus.Text = "Ollama is not installed. Choose the local AI components you want.";
            installAi.Visible = true; installAi.Enabled = true; runtimeNotice.Visible = false;
            downloadModel.Visible = true; downloadModel.Enabled = true; modelNotice.Visible = false;
            status.Text = "Choose Install to prepare the server. Local AI downloads are optional.";
        }
        else throw new ArgumentException("Unknown setup preview state.");
    }
    private async Task DetectAi() {
        try {
            bool recognized = await Task.Run(() => Program.OllamaReady());
            var tags = await Task.Run(() => Program.ReadJson("http://127.0.0.1:11434/api/tags", 3000));
            aiAvailable = recognized;
            if (!aiAvailable) throw new InvalidDataException("The local endpoint is not a recognized Ollama runtime.");
            bool recommended = Program.HasModel(tags);
            modelAvailable = recommended;
            aiStatus.Text = aiAvailable ? "Ollama is available. Existing models will be reused." : "Local AI is not ready yet.";
            installAi.Checked = false;
        } catch {
            aiAvailable = false; modelAvailable = false;
            aiStatus.Text = "Ollama is not running. Setup will check the installed application before downloading.";
            bool existing = File.Exists(ExistingOllama());
            if (existing) installAi.Text = "Start the existing Ollama application (no reinstall)";
        }
        UpdateOptions();
    }
    private async Task InstallClicked() {
        if (Program.Configuration.reviewOnly) return;
        if (installed && !aiFailed) { OpenBrowser(); return; }
        if (!CheckSpace()) return;
        ShowSetup();
        foreach (Control control in new Control[] { installAi, runtimeNotice, downloadModel, modelNotice }) control.Visible = false;
        skipRequested = false;
        working = true; install.Enabled = false; cancel.Enabled = false; installAi.Enabled = false; downloadModel.Enabled = false; progress.Visible = true; progress.Style = ProgressBarStyle.Marquee;
        try {
            if (!configureOnly && !installed) {
                await InstallServer(); installed = true;
            }
            aiCancellation = new CancellationTokenSource(); aiCancellation.CancelAfter(TimeSpan.FromHours(3));
            cancel.Enabled = true; cancel.Text = "Skip AI setup";
            if (installAi.Checked) await PrepareOllama();
            if (downloadModel.Checked) await PullModel();
            aiFailed = false;
            if (configureOnly) installed = true;
            ShowResult(true, configureOnly ? "AI_READY" : "SERVER_READY", configureOnly ? "Local AI is ready. Open StreamerAI to select the model." : "StreamerAI is installed and ready. Continue in your web browser; existing profiles and models were preserved.", "Local address: " + Program.ServerUrl);
        } catch (Exception exception) {
            if (skipRequested) {
                aiFailed = false;
                if (configureOnly) installed = true;
                ShowResult(true, "AI_SKIPPED", "Local AI setup was skipped. Your server remains available and AI can be prepared later.", "Local address: " + Program.ServerUrl);
            } else {
                aiFailed = installed || configureOnly;
                string code = aiFailed ? "AI_SETUP_FAILED" : Program.FailureCode(exception);
                ShowResult(false, code, HumanFailure(code, installed || configureOnly), "DETAIL: " + exception.Message);
            }
        } finally {
            if (aiCancellation != null) { aiCancellation.Dispose(); aiCancellation = null; }
            working = false; install.Enabled = true; cancel.Enabled = true; progress.Visible = false;
            installAi.Enabled = true; downloadModel.Enabled = true;
        }
    }
    private async Task InstallServer() {
        SetStatus("Requesting permission to install the server services…");
        string pipeName = Guid.NewGuid().ToString("N");
        PipeSecurity security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        using (NamedPipeServerStream pipe = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security)) {
            bool confirmed = false;
            Process child = Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "--elevated --pipe " + pipeName + " --parent " + Process.GetCurrentProcess().Id) { UseShellExecute = true, Verb = "runas" });
            Task receive = Task.Run(() => {
                pipe.WaitForConnection();
                using (StreamReader reader = new StreamReader(pipe)) {
                    string line;
                    while ((line = reader.ReadLine()) != null) {
                        if (line.Length > 4096) throw new InvalidDataException("Invalid setup control message.");
                        var message = Program.Json.Deserialize<Dictionary<string, object>>(line);
                        string kind = Convert.ToString(message["kind"]);
                        if (kind == "progress") SetStatus(Convert.ToString(message["message"]));
                        else if (kind == "error") {
                            object rawCode;
                            string code = message.TryGetValue("code", out rawCode) ? Convert.ToString(rawCode) : "SERVER_SETUP_FAILED";
                            if (!System.Text.RegularExpressions.Regex.IsMatch(code, "^[A-Z][A-Z0-9_]{0,63}$")) code = "SERVER_SETUP_FAILED";
                            throw new SetupFailure(code, Convert.ToString(message["message"]));
                        }
                        else if (kind == "installed") { bootstrap = Convert.ToString(message["bootstrap"]); confirmed = true; }
                    }
                }
            });
            Task exited = Task.Run(() => child.WaitForExit());
            await Task.WhenAny(receive, exited);
            if (!pipe.IsConnected && !receive.IsCompleted) { pipe.Dispose(); throw new InvalidOperationException("The elevated setup process did not connect."); }
            await receive; await exited;
            if (child.ExitCode != 0 || !confirmed) throw new InvalidOperationException("Server setup did not confirm completion.");
        }
    }
    private async Task PrepareOllama() {
        try { if (await Task.Run(() => Program.OllamaReady())) { aiAvailable = true; return; } } catch { }
        aiCancellation.Token.ThrowIfCancellationRequested();
        string existing = ExistingOllama();
        if (File.Exists(existing)) {
            SetStatus("Starting your existing Ollama installation…");
            Process.Start(new ProcessStartInfo(existing, Path.GetFileName(existing).Equals("ollama.exe", StringComparison.OrdinalIgnoreCase) ? "serve" : "") { UseShellExecute = false, CreateNoWindow = true });
        } else {
            if (String.IsNullOrEmpty(Program.Configuration.ollamaSha256)) throw new InvalidOperationException("This build has no verified Ollama installer.");
            Uri source = new Uri(Program.Configuration.ollamaUrl);
            if (source.Scheme != "https" || source.Host != "github.com" || !System.Text.RegularExpressions.Regex.IsMatch(source.AbsolutePath, "^/ollama/ollama/releases/download/v[0-9]+\\.[0-9]+\\.[0-9]+/OllamaSetup\\.exe$")) throw new InvalidDataException("Invalid official Ollama installer source.");
            string temporary = Path.Combine(Path.GetTempPath(), "StreamerAI-Ollama-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temporary);
            string installer = Path.Combine(temporary, "OllamaSetup.exe");
            try {
                SetStatus("Downloading the verified Ollama installer (about 1.7 GB)…");
                await DownloadInstaller(source, installer);
                using (FileStream file = File.OpenRead(installer)) if (file.Length != Program.Configuration.ollamaBytes || Program.Hash(file) != Program.Configuration.ollamaSha256) throw new InvalidDataException("Ollama download verification failed; nothing was installed.");
                SetStatus("Verifying the Ollama publisher…");
                await Task.Run(() => {
                    string powerShell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
                    ProcessStartInfo check = new ProcessStartInfo(powerShell, "-NoProfile -NonInteractive -Command \"$s=Get-AuthenticodeSignature -LiteralPath $env:STREAMERAI_OLLAMA_INSTALLER; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Ollama'){exit 1}\"") { UseShellExecute = false, CreateNoWindow = true };
                    check.EnvironmentVariables["STREAMERAI_OLLAMA_INSTALLER"] = installer;
                    using (Process process = Process.Start(check)) { if (!process.WaitForExit(60000) || process.ExitCode != 0) throw new InvalidDataException("The Ollama publisher could not be verified."); }
                    aiCancellation.Token.ThrowIfCancellationRequested();
                    BeginInvoke((Action)(() => { cancel.Enabled = false; status.Text = "Installing Ollama for your Windows account…"; }));
                    Program.Run(installer, "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART", temporary, 600000);
                });
            } finally {
                if (Path.GetFullPath(temporary).StartsWith(Path.GetFullPath(Path.GetTempPath()) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) try { Directory.Delete(temporary, true); } catch { }
            }
        }
        SetStatus("Waiting for Ollama to start…");
        for (int attempt = 0; attempt < 60; attempt++) {
            aiCancellation.Token.ThrowIfCancellationRequested();
            try { if (await Task.Run(() => Program.OllamaReady())) { aiAvailable = true; cancel.Enabled = true; return; } } catch { }
            await Task.Delay(1000);
        }
        throw new InvalidOperationException("Ollama was prepared but is not responding yet. Open it from the Start menu and retry local AI setup.");
    }
    private async Task PullModel() {
        SetStatus("Checking whether the recommended model is already available…");
        await Task.Run(() => {
            var tags = Program.ReadJson("http://127.0.0.1:11434/api/tags", 5000);
            if (Program.HasModel(tags)) return;
            SetStatus("Downloading Qwen 3.5 4B (about 3.4 GB)…");
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:11434/api/pull");
            request.Proxy = null; request.AllowAutoRedirect = false; request.Method = "POST"; request.ContentType = "application/json"; request.Timeout = 120000; request.ReadWriteTimeout = 120000;
            byte[] body = Encoding.UTF8.GetBytes("{\"model\":\"" + Program.Model + "\",\"stream\":true}");
            request.ContentLength = body.Length;
            using (CancellationTokenRegistration cancelled = aiCancellation.Token.Register(() => request.Abort())) {
            using (Stream stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
            bool success = false;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream())) {
                string line;
                while ((line = ReadBoundedLine(reader)) != null) {
                    aiCancellation.Token.ThrowIfCancellationRequested();
                    var message = Program.Json.Deserialize<Dictionary<string, object>>(line);
                    if (message.ContainsKey("error")) throw new InvalidOperationException("Ollama could not finish downloading the model.");
                    if (message.ContainsKey("status") && Convert.ToString(message["status"]) == "success") success = true;
                    if (message.ContainsKey("total") && message.ContainsKey("completed")) {
                        double total = Convert.ToDouble(message["total"]), completed = Convert.ToDouble(message["completed"]);
                        if (total > 0) SetStatus("Downloading Qwen 3.5 4B… " + Math.Min(100, Math.Max(0, (int)(completed / total * 100))) + "%");
                    }
                }
            }
            if (!success) throw new InvalidOperationException("Ollama did not confirm that the model download completed.");
            if (!Program.HasModel(Program.ReadJson("http://127.0.0.1:11434/api/tags", 5000))) throw new InvalidOperationException("Ollama has not made the downloaded model available yet.");
            }
        });
    }
    private static string ReadBoundedLine(TextReader reader) {
        StringBuilder line = new StringBuilder();
        for (;;) {
            int character = reader.Read();
            if (character == -1) return line.Length == 0 ? null : line.ToString();
            if (character == '\n') return line.ToString().TrimEnd('\r');
            if (line.Length >= 65536) throw new InvalidDataException("The model download response is too large.");
            line.Append((char)character);
        }
    }
    private async Task DownloadInstaller(Uri initial, string filename) {
        CancellationToken token = aiCancellation.Token;
        await Task.Run(() => {
            Uri source = initial;
            for (int redirect = 0; redirect < 6; redirect++) {
                token.ThrowIfCancellationRequested();
                if (source.Scheme != "https" || !new[] { "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com" }.Contains(source.Host)) throw new InvalidDataException("The Ollama download redirected to an unapproved source.");
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(source);
                request.AllowAutoRedirect = false; request.Timeout = 30000; request.ReadWriteTimeout = 60000; request.UserAgent = "StreamerAI-Setup/" + Program.Configuration.version;
                using (CancellationTokenRegistration cancelled = token.Register(() => request.Abort()))
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) {
                    int statusCode = (int)response.StatusCode;
                    if (statusCode >= 300 && statusCode < 400) {
                        string location = response.Headers["Location"];
                        if (String.IsNullOrEmpty(location)) throw new InvalidDataException("The Ollama download has no redirect destination.");
                        source = new Uri(source, location); continue;
                    }
                    if (statusCode != 200 || (response.ContentLength >= 0 && response.ContentLength != Program.Configuration.ollamaBytes)) throw new InvalidDataException("The Ollama installer download has an unexpected size.");
                    using (Stream input = response.GetResponseStream())
                    using (FileStream output = new FileStream(filename, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                        byte[] buffer = new byte[65536]; long received = 0; int read; int lastPercent = -1;
                        while ((read = input.Read(buffer, 0, buffer.Length)) > 0) {
                            token.ThrowIfCancellationRequested(); received += read;
                            if (received > Program.Configuration.ollamaBytes) throw new InvalidDataException("The Ollama download exceeded its pinned size.");
                            output.Write(buffer, 0, read);
                            int percent = (int)(received * 100 / Program.Configuration.ollamaBytes);
                            if (percent != lastPercent) { lastPercent = percent; SetStatus("Downloading Ollama… " + percent + "%"); }
                        }
                        output.Flush(true);
                        if (received != Program.Configuration.ollamaBytes) throw new InvalidDataException("The Ollama download was incomplete.");
                    }
                    return;
                }
            }
            throw new InvalidDataException("The Ollama download redirected too many times.");
        }, token);
    }
    private bool CheckSpace() {
        Dictionary<string, long> needed = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        Action<string, long> add = (directory, bytes) => {
            string absolute = Path.GetFullPath(directory);
            string root = Path.GetPathRoot(absolute);
            if (String.IsNullOrEmpty(root) || root.StartsWith("\\\\", StringComparison.Ordinal)) throw new IOException("A local disk is required for automatic AI setup.");
            long previous; needed.TryGetValue(root, out previous); needed[root] = previous + bytes;
        };
        try {
            if (!configureOnly && !installed) add(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Math.Max(1024L * 1024 * 1024, Program.Configuration.payloadUnpackedBytes * 2));
            if (installAi.Checked && !aiAvailable && !File.Exists(ExistingOllama())) {
                add(Path.GetTempPath(), Program.Configuration.ollamaBytes + 100L * 1024 * 1024);
                add(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), 4L * 1024 * 1024 * 1024);
            }
            if (downloadModel.Checked) {
                string custom = Environment.GetEnvironmentVariable("OLLAMA_MODELS");
                if (!String.IsNullOrWhiteSpace(custom) && !Path.IsPathRooted(custom)) throw new IOException("OLLAMA_MODELS must name an absolute local folder for automatic model setup.");
                string models = String.IsNullOrWhiteSpace(custom) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".ollama", "models") : custom;
                add(models, 4L * 1024 * 1024 * 1024);
            }
            foreach (KeyValuePair<string, long> item in needed) {
                DriveInfo drive = new DriveInfo(item.Key);
                if (!drive.IsReady || drive.DriveType == DriveType.Network) throw new IOException("The free space on an installation disk could not be checked.");
                if (drive.AvailableFreeSpace < item.Value) {
                    status.Text = "Not enough free space on " + item.Key + ". This selection needs approximately " + Math.Ceiling(item.Value / (1024d * 1024 * 1024)) + " GB free. Change the selection or free disk space first.";
                    return false;
                }
            }
            return true;
        } catch (Exception exception) {
            return MessageBox.Show("Setup could not verify all required disk space: " + exception.Message + "\nContinue with this selection?", "Check disk space", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes;
        }
    }
    private void OpenBrowser() {
        string url = Program.ServerUrl;
        if (!String.IsNullOrEmpty(bootstrap)) { url += "/#setup=" + Uri.EscapeDataString(bootstrap); bootstrap = null; }
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
    private static string ExistingOllama() {
        string[] roots = { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Ollama"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Ollama") };
        foreach (string root in roots) foreach (string name in new[] { "ollama app.exe", "ollama.exe" }) { string filename = Path.Combine(root, name); if (File.Exists(filename)) return filename; }
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)) {
            try {
                string expanded = Environment.ExpandEnvironmentVariables(directory.Trim().Trim('"'));
                if (!Path.IsPathRooted(expanded) || expanded.StartsWith("\\\\", StringComparison.Ordinal)) continue;
                string filename = Path.GetFullPath(Path.Combine(expanded, "ollama.exe"));
                if (File.Exists(filename)) return filename;
            } catch (ArgumentException) { } catch (NotSupportedException) { }
        }
        return Path.Combine(roots[0], "ollama app.exe");
    }
}
