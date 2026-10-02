// Aiutante per Windows della modalità window: uno script PowerShell che resta in esecuzione e
// risponde a richieste JSON (una per riga) su stdin/stdout. Usa solo ciò che Windows ha già:
// Windows PowerShell 5.1, .NET Framework, PrintWindow e UI Automation. Nessun modulo nativo.
//
// Lo script arriva al processo come prima riga di stdin (in base64) ed è eseguito in memoria:
// niente file .ps1 sul disco, quindi niente blocchi dei criteri di esecuzione degli script.

/** Comando di avvio: legge lo script dalla prima riga di stdin e lo esegue. */
export const WIN32_BOOTSTRAP = '$s=[Console]::In.ReadLine();Invoke-Expression([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)))';

const CORE_USINGS = [
  'System',
  'System.Collections.Generic',
  'System.Drawing',
  'System.Drawing.Drawing2D',
  'System.Drawing.Imaging',
  'System.IO',
  'System.Runtime.InteropServices',
  'System.Text',
];
const UIA_USINGS = ['System.Diagnostics', 'System.Windows.Automation'];

const CSHARP_CORE = String.raw`
public static class RlsWin {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lparam);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong32(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int v, int size);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PROCESSENTRY32 {
    public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  public static void DpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }

  // Pixel dell'app per ogni pixel dello schermo. Vale 1 per le app che gestiscono il DPI; è
  // minore di 1 per quelle che non lo gestiscono su uno schermo ingrandito: Windows le disegna
  // alla loro misura (es. 96 dpi) e poi ingrandisce il risultato. Studio lavora nei pixel
  // dell'app: immagine nitida, e misure uguali a quelle scritte nel suo codice.
  public static double Ratio(IntPtr h) {
    try {
      uint win = GetDpiForWindow(h);
      uint mx, my;
      if (win == 0 || GetDpiForMonitor(MonitorFromWindow(h, 2), 0, out mx, out my) != 0 || mx == 0) return 1.0;
      return win < mx ? (double)win / mx : 1.0;
    } catch { return 1.0; }
  }

  static long ExStyle(IntPtr h) { return IntPtr.Size == 8 ? GetWindowLongPtr64(h, -20).ToInt64() : GetWindowLong32(h, -20); }

  public static RECT Frame(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0 || r.R <= r.L) GetWindowRect(h, out r);
    return r;
  }

  // Il processo indicato e tutti i suoi discendenti (anche se un processo intermedio è già uscito)
  static HashSet<uint> Tree(uint root) {
    var parents = new Dictionary<uint, uint>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap != IntPtr.Zero && snap != new IntPtr(-1)) {
      var e = new PROCESSENTRY32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (Process32FirstW(snap, ref e)) { do { parents[e.th32ProcessID] = e.th32ParentProcessID; } while (Process32NextW(snap, ref e)); }
      CloseHandle(snap);
    }
    var set = new HashSet<uint>(); set.Add(root);
    bool grew = true;
    while (grew) {
      grew = false;
      foreach (var kv in parents) { if (kv.Key != 0 && !set.Contains(kv.Key) && set.Contains(kv.Value)) { set.Add(kv.Key); grew = true; } }
    }
    return set;
  }

  public static List<Dictionary<string, object>> List(long rootPid, string title) {
    var tree = rootPid > 0 ? Tree((uint)rootPid) : null;
    var filter = (title ?? "").Trim();
    var result = new List<Dictionary<string, object>>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (tree != null && !tree.Contains(pid)) return true;
      int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0) return true;
      bool tool = (ExStyle(h) & 0x80) != 0;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      string text = sb.ToString();
      bool iconic = IsIconic(h);
      RECT r = Frame(h);
      double ratio = Ratio(h);
      int w = (int)Math.Round((r.R - r.L) * ratio), hh = (int)Math.Round((r.B - r.T) * ratio);
      if (!iconic && (w < 40 || hh < 30)) return true;
      if (filter.Length > 0 && text.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) return true;
      // Senza un processo di riferimento contano solo le finestre vere delle app (con un titolo)
      if (tree == null && (text.Length == 0 || tool)) return true;
      bool owned = GetWindow(h, 4) != IntPtr.Zero;
      var d = new Dictionary<string, object>();
      d["id"] = h.ToInt64().ToString(); d["pid"] = (long)pid; d["title"] = text; d["minimized"] = iconic;
      d["width"] = iconic ? 0 : w; d["height"] = iconic ? 0 : hh;
      d["main"] = !owned && !tool && text.Length > 0;
      result.Add(d);
      return true;
    }, IntPtr.Zero);
    return result;
  }

  static string Hash(Bitmap bmp) {
    var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      int bytes = Math.Abs(data.Stride) * bmp.Height;
      var buf = new byte[bytes];
      Marshal.Copy(data.Scan0, buf, 0, bytes);
      ulong h = 14695981039346656037UL;
      // Un campione fitto basta a riconoscere un'immagine identica alla precedente
      for (int i = 0; i < bytes; i += 29) { h ^= buf[i]; h *= 1099511628211UL; }
      return h.ToString("x") + "-" + bmp.Width + "x" + bmp.Height;
    } finally { bmp.UnlockBits(data); }
  }

  static bool Blank(Bitmap bmp) {
    int stepX = Math.Max(1, bmp.Width / 24), stepY = Math.Max(1, bmp.Height / 24);
    for (int y = stepY / 2; y < bmp.Height; y += stepY)
      for (int x = stepX / 2; x < bmp.Width; x += stepX) { var c = bmp.GetPixel(x, y); if (c.A != 0 && (c.R | c.G | c.B) != 0) return false; }
    return true;
  }

  static Bitmap Grab(IntPtr h) {
    RECT w; GetWindowRect(h, out w);
    RECT f = Frame(h);
    int width = w.R - w.L, height = w.B - w.T;
    if (width <= 0 || height <= 0) return null;
    var full = new Bitmap(width, height, PixelFormat.Format32bppArgb);
    bool ok = false;
    // PW_RENDERFULLCONTENT (2): vale anche per le finestre disegnate con la GPU e per quelle coperte
    foreach (uint flags in new uint[] { 2, 0 }) {
      using (var g = Graphics.FromImage(full)) { g.Clear(Color.Black); IntPtr hdc = g.GetHdc(); try { ok = PrintWindow(h, hdc, flags); } finally { g.ReleaseHdc(hdc); } }
      if (ok && !Blank(full)) break;
      ok = false;
    }
    if (!ok) {
      // Ultima risorsa: copia dallo schermo (corretta solo se la finestra non è coperta)
      using (var g = Graphics.FromImage(full)) g.CopyFromScreen(w.L, w.T, 0, 0, new Size(width, height));
    }
    // Ritaglio ai bordi visibili: senza la cornice invisibile di Windows 10/11. Un'app che non
    // gestisce il DPI ha disegnato alla sua misura, nell'angolo in alto a sinistra dell'immagine.
    double ratio = ok ? Ratio(h) : 1.0;
    var crop = Rectangle.Intersect(
      new Rectangle((int)Math.Round((f.L - w.L) * ratio), (int)Math.Round((f.T - w.T) * ratio), (int)Math.Round((f.R - f.L) * ratio), (int)Math.Round((f.B - f.T) * ratio)),
      new Rectangle(0, 0, width, height));
    if (crop.Width <= 0 || crop.Height <= 0 || (crop.Width == width && crop.Height == height)) return full;
    var cut = full.Clone(crop, PixelFormat.Format32bppArgb);
    full.Dispose();
    return cut;
  }

  public static Dictionary<string, object> Capture(long handle, string format, int quality, int maxW, int maxH, string lastHash) {
    var d = new Dictionary<string, object>();
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h) || !IsWindowVisible(h)) { d["status"] = "gone"; return d; }
    if (IsIconic(h)) { d["status"] = "minimized"; return d; }
    using (Bitmap bmp = Grab(h)) {
      if (bmp == null) { d["status"] = "minimized"; return d; }
      uint dpi = 96; try { dpi = GetDpiForWindow(h); } catch { }
      if (dpi == 0) dpi = 96;
      d["width"] = bmp.Width; d["height"] = bmp.Height; d["scale"] = dpi > 0 ? dpi / 96.0 : 1.0;
      string hash = Hash(bmp);
      d["hash"] = hash;
      if (!string.IsNullOrEmpty(lastHash) && lastHash == hash) { d["status"] = "same"; return d; }
      Bitmap outBmp = bmp; bool scaled = false;
      if (maxW > 0 && maxH > 0 && (bmp.Width > maxW || bmp.Height > maxH)) {
        double k = Math.Min((double)maxW / bmp.Width, (double)maxH / bmp.Height);
        int nw = Math.Max(1, (int)Math.Round(bmp.Width * k)), nh = Math.Max(1, (int)Math.Round(bmp.Height * k));
        outBmp = new Bitmap(nw, nh, PixelFormat.Format24bppRgb); scaled = true;
        using (var g = Graphics.FromImage(outBmp)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.PixelOffsetMode = PixelOffsetMode.HighQuality; g.DrawImage(bmp, 0, 0, nw, nh); }
      }
      try {
        using (var ms = new MemoryStream()) {
          if (format == "jpeg") {
            ImageCodecInfo codec = null;
            foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.FormatID == ImageFormat.Jpeg.Guid) codec = c;
            var p = new EncoderParameters(1); p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(30, Math.Min(95, quality)));
            outBmp.Save(ms, codec, p);
          } else {
            outBmp.Save(ms, ImageFormat.Png);
          }
          d["data"] = Convert.ToBase64String(ms.ToArray());
        }
      } finally { if (scaled) outBmp.Dispose(); }
      d["status"] = "ok";
      return d;
    }
  }

  public static void Show(long handle) {
    IntPtr h = new IntPtr(handle);
    if (IsIconic(h)) ShowWindow(h, 4); // SW_SHOWNOACTIVATE: torna visibile senza prendere il focus
  }

  public static void Activate(long handle) {
    IntPtr h = new IntPtr(handle);
    if (IsIconic(h)) ShowWindow(h, 9);
    // Un tasto Alt "a vuoto" sblocca il divieto di Windows di portare in primo piano da un processo in background
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
  }
}
`;

const CSHARP_UIA = String.raw`
public static class RlsUia {
  static string Clean(string s, int max) {
    if (string.IsNullOrEmpty(s)) return "";
    var sb = new System.Text.StringBuilder();
    foreach (char c in s) { sb.Append(char.IsControl(c) ? ' ' : c); if (sb.Length >= max) break; }
    return sb.ToString().Trim();
  }

  static string Role(AutomationElement e) {
    try { string n = e.Current.ControlType.ProgrammaticName; return n.StartsWith("ControlType.") ? n.Substring(12) : n; } catch { return ""; }
  }

  static string Label(AutomationElement e) {
    string role = Role(e), name = "";
    try { name = Clean(e.Current.Name, 60); } catch { }
    return name.Length > 0 ? role + " «" + name + "»" : role;
  }

  // Elemento più interno della finestra che contiene il punto. Si scende nell'albero di
  // accessibilità della finestra (non si chiede "cosa c'è in quel punto dello schermo"), così
  // funziona anche quando la finestra è coperta da un'altra, per esempio dal browser.
  public static Dictionary<string, object> ElementAt(long handle, int x, int y) {
    var hwnd = new IntPtr(handle);
    var frame = RlsWin.Frame(hwnd);
    double ratio = RlsWin.Ratio(hwnd);
    var pt = new System.Windows.Point(frame.L + x / ratio, frame.T + y / ratio);
    AutomationElement cur = AutomationElement.FromHandle(hwnd);
    var walker = TreeWalker.ControlViewWalker;
    var path = new List<string>();
    var clock = Stopwatch.StartNew();
    for (int depth = 0; depth < 48 && clock.ElapsedMilliseconds < 700; depth++) {
      AutomationElement best = null; double bestArea = double.MaxValue;
      AutomationElement child = null;
      try { child = walker.GetFirstChild(cur); } catch { }
      int seen = 0;
      while (child != null && seen++ < 600 && clock.ElapsedMilliseconds < 700) {
        try {
          System.Windows.Rect r = child.Current.BoundingRectangle;
          if (!r.IsEmpty && r.Width > 0 && r.Height > 0 && r.Contains(pt)) {
            double area = r.Width * r.Height;
            if (area <= bestArea) { best = child; bestArea = area; }
          }
        } catch { }
        try { child = walker.GetNextSibling(child); } catch { child = null; }
      }
      if (best == null) break;
      path.Add(Label(cur));
      cur = best;
    }
    var d = new Dictionary<string, object>();
    var info = cur.Current;
    System.Windows.Rect b = info.BoundingRectangle;
    d["role"] = Role(cur);
    d["name"] = Clean(info.Name, 200);
    d["automationId"] = Clean(info.AutomationId, 120);
    d["className"] = Clean(info.ClassName, 120);
    d["framework"] = Clean(info.FrameworkId, 40);
    d["path"] = path;
    d["x"] = b.IsEmpty ? 0 : (int)Math.Round((b.X - frame.L) * ratio);
    d["y"] = b.IsEmpty ? 0 : (int)Math.Round((b.Y - frame.T) * ratio);
    d["width"] = b.IsEmpty ? 0 : (int)Math.Round(b.Width * ratio);
    d["height"] = b.IsEmpty ? 0 : (int)Math.Round(b.Height * ratio);
    return d;
  }

  // Controlli che stanno dentro una zona della finestra (strumento Riquadro): i più piccoli
  // contenuti per almeno metà, con un nome o un AutomationId, al più 'limit'. Visita in
  // ampiezza dell'albero di accessibilità, con un limite di tempo.
  public static List<Dictionary<string, object>> ElementsIn(long handle, int x, int y, int w, int h, int limit) {
    var hwnd = new IntPtr(handle);
    var frame = RlsWin.Frame(hwnd);
    double ratio = RlsWin.Ratio(hwnd);
    var zone = new System.Windows.Rect(frame.L + x / ratio, frame.T + y / ratio, Math.Max(1, w / ratio), Math.Max(1, h / ratio));
    var walker = TreeWalker.ControlViewWalker;
    var found = new List<Dictionary<string, object>>();
    var queue = new Queue<KeyValuePair<AutomationElement, int>>();
    queue.Enqueue(new KeyValuePair<AutomationElement, int>(AutomationElement.FromHandle(hwnd), 0));
    var clock = Stopwatch.StartNew();
    int visited = 0;
    while (queue.Count > 0 && found.Count < limit && clock.ElapsedMilliseconds < 900 && visited < 4000) {
      var item = queue.Dequeue();
      AutomationElement child = null;
      try { child = walker.GetFirstChild(item.Key); } catch { }
      while (child != null && visited++ < 4000) {
        try {
          var info = child.Current;
          System.Windows.Rect r = info.BoundingRectangle;
          if (!r.IsEmpty && r.Width > 0 && r.Height > 0 && r.IntersectsWith(zone)) {
            var inter = System.Windows.Rect.Intersect(r, zone);
            bool mostlyInside = inter.Width * inter.Height >= 0.5 * r.Width * r.Height;
            bool smallerThanZone = r.Width * r.Height <= zone.Width * zone.Height * 1.1;
            string name = Clean(info.Name, 60), id = Clean(info.AutomationId, 80);
            if (mostlyInside && smallerThanZone && (name.Length > 0 || id.Length > 0) && found.Count < limit) {
              var d = new Dictionary<string, object>();
              d["role"] = Role(child);
              d["name"] = name;
              d["automationId"] = id;
              found.Add(d);
            } else if (item.Value < 12) {
              // Un contenitore che interseca la zona: si guarda dentro
              queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, item.Value + 1));
            }
          }
        } catch { }
        try { child = walker.GetNextSibling(child); } catch { child = null; }
      }
    }
    return found;
  }
}
`;

const usings = (names: string[]) => names.map((n) => `using ${n};`).join('\n');

/** Script completo: definisce le classi C#, si annuncia e poi serve le richieste. */
export const WIN32_SCRIPT = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = $utf8 } catch { }
try { [Console]::InputEncoding = $utf8 } catch { }
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.AutoFlush = $true
$inp = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
function Send($obj) { $out.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 6)) }
$elements = $false
try {
  # Con UI Automation (strumento Elemento); se su questo sistema non si compila, solo la cattura
  Add-Type -ReferencedAssemblies System.Drawing, UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @'
${usings([...CORE_USINGS, ...UIA_USINGS])}
${CSHARP_CORE}
${CSHARP_UIA}
'@
  $elements = $true
} catch {
  try {
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
${usings(CORE_USINGS)}
${CSHARP_CORE}
'@
  } catch {
    Send @{ ready = $false; error = "$($_.Exception.Message)" }
    exit 1
  }
}
[RlsWin]::DpiAware()
Send @{ ready = $true; elements = $elements }
while ($true) {
  $line = $inp.ReadLine()
  if ($line -eq $null) { break }
  if (-not $line.Trim()) { continue }
  $res = @{}
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    switch ($req.op) {
      'list' { $res = @{ windows = @([RlsWin]::List([long]$req.root, [string]$req.title)) } }
      'capture' { $res = [RlsWin]::Capture([long]$req.handle, [string]$req.format, [int]$req.quality, [int]$req.maxWidth, [int]$req.maxHeight, [string]$req.lastHash) }
      'show' { [RlsWin]::Show([long]$req.handle) }
      'activate' { [RlsWin]::Activate([long]$req.handle) }
      'element' { if ($elements) { $res = [RlsUia]::ElementAt([long]$req.handle, [int]$req.x, [int]$req.y) } else { $res = @{ error = 'non disponibile' } } }
      'elementsIn' { if ($elements) { $res = @{ items = @([RlsUia]::ElementsIn([long]$req.handle, [int]$req.x, [int]$req.y, [int]$req.width, [int]$req.height, 12)) } } else { $res = @{ items = @() } } }
      default { $res = @{ error = 'operazione sconosciuta' } }
    }
  } catch {
    $res = @{ error = "$($_.Exception.Message)" }
  }
  $res['id'] = $id
  Send $res
}
`;
