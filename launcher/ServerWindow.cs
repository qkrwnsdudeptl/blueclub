using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal sealed class ServerWindow : Form
{
    private static readonly string Address = "http://" + (Environment.GetEnvironmentVariable("ERP_HOST") ?? "192.168.100.117")
        + ":" + (Environment.GetEnvironmentVariable("ERP_PORT") ?? "8000");
    private const string StartupKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string StartupName = "ErpBismuriServer";
    private readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    private readonly Button start = new Button { Text = "서버 켜기", AutoSize = true };
    private readonly Button stop = new Button { Text = "서버 끄기", AutoSize = true, Enabled = false };
    private readonly Button browser = new Button { Text = "브라우저에서 열기", AutoSize = true };
    private readonly Button notice = new Button { Text = "전체 팝업 발송", AutoSize = true };
    private readonly NotifyIcon tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "erp비스무리 서버" };
    private readonly CheckBox startup = new CheckBox { Text = "Windows 로그인 시 서버 자동 실행", AutoSize = true };
    private readonly TextBox log = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical };
    private readonly object logLock = new object();
    private Process server;
    private bool closingAfterStop;

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [STAThread]
    private static void Main(string[] args)
    {
        bool background = Array.IndexOf(args, "--autostart") >= 0;
        bool acquired;
        using (var wake = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\ErpBismuriServerShow"))
        using (var gate = new Mutex(true, "Local\\ErpBismuriServerLauncher", out acquired))
        {
            if (!acquired)
            {
                if (!background) wake.Set();
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var window = new ServerWindow())
            {
                var handle = window.Handle;
                var wait = ThreadPool.RegisterWaitForSingleObject(wake,
                    (state, timedOut) => window.OnUi(window.ShowWindow), null, Timeout.Infinite, false);
                window.BeginInvoke(new Action(() =>
                {
                    if (!background) window.ShowWindow();
                    window.StartServer();
                }));
                try { Application.Run(); }
                finally { wait.Unregister(null); }
            }
        }
    }

    private ServerWindow()
    {
        Text = "erp비스무리 서버";
        Size = new Size(770, 475);
        MinimumSize = new Size(560, 360);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Malgun Gothic", 10);
        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, WrapContents = true, Padding = new Padding(8) };
        toolbar.Controls.AddRange(new Control[] { start, stop, browser, notice, startup });
        Controls.Add(log);
        Controls.Add(toolbar);
        using (var key = Registry.CurrentUser.OpenSubKey(StartupKey))
            startup.Checked = key != null && key.GetValue(StartupName) != null;
        startup.CheckedChanged += (sender, args) => SetStartup();
        start.Click += (sender, args) => StartServer();
        stop.Click += (sender, args) => StopServer();
        notice.Click += (sender, args) => ShowNoticeComposer();
        tray.ContextMenuStrip = new ContextMenuStrip();
        tray.ContextMenuStrip.Items.Add("실행기 열기", null, (sender, args) => ShowWindow());
        tray.ContextMenuStrip.Items.Add("전체 팝업 발송", null, (sender, args) => { ShowWindow(); ShowNoticeComposer(); });
        tray.ContextMenuStrip.Items.Add("서버와 실행기 종료", null, (sender, args) =>
        {
            closingAfterStop = true;
            if (server == null) Close();
            else StopServer();
        });
        tray.DoubleClick += (sender, args) => ShowWindow();
        tray.Visible = true;
        browser.Click += (sender, args) =>
        {
            try { Process.Start(new ProcessStartInfo(Address) { UseShellExecute = true }); }
            catch (Exception ex) { WriteLog("브라우저 열기 실패: " + ex.Message); }
        };
        FormClosing += (sender, args) =>
        {
            if (!closingAfterStop && args.CloseReason != CloseReason.WindowsShutDown)
            {
                args.Cancel = true;
                Hide();
            }
        };
        FormClosed += (sender, args) =>
        {
            tray.Dispose();
            Application.ExitThread();
        };
        Shown += (sender, args) => WriteLog("주소: " + Address + " / 로그: logs\\server.log");
    }

    private void ShowWindow()
    {
        Show();
        ShowWindow(Handle, 5);
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    private void ShowNoticeComposer()
    {
        using (var composer = new Form { Text = "전체 팝업 발송", Width = 540, Height = 420, StartPosition = FormStartPosition.CenterParent })
        {
            var fields = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(12), AutoScroll = true };
            var title = new TextBox { Width = 470, MaxLength = 80 };
            var message = new TextBox { Width = 470, Height = 100, Multiline = true, MaxLength = 1000, ScrollBars = ScrollBars.Vertical };
            var mode = new ComboBox { Width = 470, DropDownStyle = ComboBoxStyle.DropDownList };
            mode.Items.AddRange(new object[] { "일시형 · 접속 중인 화면에 표시", "지속형 · 새 접속에도 표시" });
            mode.SelectedIndex = 0;
            var code = new TextBox { Width = 150, UseSystemPasswordChar = true };
            var send = new Button { Text = "전체 발송", AutoSize = true };
            var withdraw = new Button { Text = "공지 내리기", AutoSize = true };
            var status = new Label { AutoSize = true, MaximumSize = new Size(470, 0) };
            var actions = new FlowLayoutPanel { AutoSize = true };
            actions.Controls.AddRange(new Control[] { send, withdraw });
            fields.Controls.AddRange(new Control[] {
                new Label { Text = "제목", AutoSize = true }, title,
                new Label { Text = "내용", AutoSize = true }, message,
                mode, new Label { Text = "관리자 코드", AutoSize = true }, code, actions, status
            });
            composer.Controls.Add(fields);
            Func<bool, Task> submit = async remove =>
            {
                var payload = new { title = title.Text, message = message.Text, mode = mode.SelectedIndex == 1 ? "persistent" : "temporary" };
                if (code.Text.Length != 2 || (!remove && (string.IsNullOrWhiteSpace(payload.title) || string.IsNullOrWhiteSpace(payload.message))))
                {
                    status.Text = "관리자 코드를 입력하고, 발송 시 제목과 내용을 채워 주세요.";
                    return;
                }
                var adminCode = code.Text;
                send.Enabled = withdraw.Enabled = false;
                try
                {
                    await Task.Run(() => ChangeNotice(adminCode, payload, remove));
                    if (composer.IsDisposed) return;
                    status.Text = remove ? "공지를 내렸습니다." : "전체 발송을 완료했습니다.";
                    if (!remove) { title.Clear(); message.Clear(); }
                    code.Clear();
                }
                catch (Exception ex) { if (!composer.IsDisposed) status.Text = ex.Message; }
                finally { if (!composer.IsDisposed) send.Enabled = withdraw.Enabled = true; }
            };
            send.Click += async (sender, args) => await submit(false);
            withdraw.Click += async (sender, args) => await submit(true);
            composer.ShowDialog(this);
        }
    }

    private static void ChangeNotice(string code, object payload, bool remove)
    {
        var cookies = new CookieContainer();
        try
        {
            SendJson("/api/admin/login", "POST", new { code }, cookies);
            SendJson("/api/admin/notice", remove ? "DELETE" : "POST", remove ? new object() : payload, cookies);
        }
        catch (WebException ex)
        {
            if (ex.Response == null) throw new InvalidOperationException("서버 연결에 실패했습니다. 실행기의 서버 로그를 확인해 주세요.", ex);
            using (var response = (HttpWebResponse)ex.Response)
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                var body = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(reader.ReadToEnd());
                throw new InvalidOperationException(Convert.ToString(body["error"]), ex);
            }
        }
    }

    private static void SendJson(string path, string method, object value, CookieContainer cookies)
    {
        var bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(value));
        var request = (HttpWebRequest)WebRequest.Create(Address + path);
        request.Proxy = null;
        request.CookieContainer = cookies;
        request.Method = method;
        request.ContentType = "application/json";
        request.ContentLength = bytes.Length;
        request.Timeout = request.ReadWriteTimeout = 5000;
        using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
        using (var response = request.GetResponse()) { }
    }

    private void SetStartup()
    {
        try
        {
            using (var key = Registry.CurrentUser.CreateSubKey(StartupKey))
            {
                if (startup.Checked)
                    key.SetValue(StartupName, "\"" + Application.ExecutablePath + "\" --autostart");
                else
                    key.DeleteValue(StartupName, false);
            }
            WriteLog(startup.Checked ? "로그인 시 자동 실행을 설정했습니다." : "자동 실행 설정을 해제했습니다.");
        }
        catch (Exception ex) { WriteLog("자동 실행 설정 실패: " + ex.Message); }
    }

    private void StartServer()
    {
        if (server != null) return;
        var app = Path.Combine(root, "app.py");
        if (!File.Exists(app))
        {
            WriteLog("실행기와 같은 폴더에 app.py가 필요합니다.");
            return;
        }
        var process = new Process
        {
            StartInfo = new ProcessStartInfo("python.exe", "-u \"" + app + "\" --launcher")
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            },
            EnableRaisingEvents = true
        };
        process.StartInfo.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        process.OutputDataReceived += (sender, args) => { if (args.Data != null) WriteLog(args.Data); };
        process.ErrorDataReceived += (sender, args) => { if (args.Data != null) WriteLog(args.Data); };
        process.Exited += (sender, args) => OnUi(() => ServerExited(process));
        try
        {
            process.Start();
            server = process;
            start.Enabled = false;
            stop.Enabled = true;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            process.Dispose();
            server = null;
            start.Enabled = true;
            stop.Enabled = false;
            WriteLog("서버 시작 실패: " + ex.Message);
        }
    }

    private void StopServer()
    {
        if (server == null || !stop.Enabled) return;
        stop.Enabled = false;
        try
        {
            server.StandardInput.WriteLine("stop");
            server.StandardInput.Flush();
            WriteLog("서버 종료를 요청했습니다.");
        }
        catch (Exception ex) { stop.Enabled = true; WriteLog("종료 요청 실패: " + ex.Message); }
    }

    private void ServerExited(Process process)
    {
        if (server != process) return;
        WriteLog("서버 종료 · 코드 " + process.ExitCode);
        process.Dispose();
        server = null;
        start.Enabled = true;
        stop.Enabled = false;
        if (closingAfterStop) Close();
    }

    private void OnUi(Action action)
    {
        if (IsDisposed || !IsHandleCreated) return;
        if (!InvokeRequired) { action(); return; }
        try { BeginInvoke(action); } catch (InvalidOperationException) { }
    }

    private void WriteLog(string message)
    {
        string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine;
        lock (logLock)
        {
            try
            {
                string folder = Path.Combine(root, "logs");
                Directory.CreateDirectory(folder);
                File.AppendAllText(Path.Combine(folder, "server.log"), line, Encoding.UTF8);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        OnUi(() =>
        {
            if (log.TextLength > 120000) log.Text = log.Text.Substring(log.TextLength - 80000);
            log.AppendText(line);
        });
    }
}
