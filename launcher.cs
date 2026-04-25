using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

class MCPanelLauncher {
    [STAThread]
    static void Main() {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        ProcessStartInfo psi = new ProcessStartInfo {
            FileName = "cmd.exe",
            Arguments = "/c npm start",
            WorkingDirectory = dir,
            WindowStyle = ProcessWindowStyle.Hidden,
            CreateNoWindow = true
        };
        Process.Start(psi);
    }
}
