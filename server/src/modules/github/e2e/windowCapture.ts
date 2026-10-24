import { execFile } from "node:child_process";

/**
 * Скриншот окна настольной Windows-программы — только этого окна (PrintWindow по его дескриптору),
 * не экрана: чужие окна пользователя в отчёт не попадают. Окно ищется по заголовку и только у процессов,
 * запущенных после startedAt, — открытое пользователем окно с похожим заголовком не подойдёт.
 * Возвращает PNG в base64 или null, если окна (ещё) нет.
 */
export async function captureWindow(title: string, startedAt: Date): Promise<{ png: string; windowTitle: string; pid: number } | null> {
    if (process.platform !== "win32") {
        throw new Error("window screenshots are only supported on Windows");
    }

    const script = [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.Drawing",
        "Add-Type @'",
        "using System; using System.Runtime.InteropServices;",
        "public static class JustAIWindow {",
        "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }",
        "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r);",
        "  [DllImport(\"user32.dll\")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);",
        "}",
        "'@",
        `$since = [DateTime]::Parse('${startedAt.toISOString()}').ToLocalTime()`,
        `$pattern = '${title.replace(/'/g, "''")}'`,
        // У системных процессов StartTime недоступен (нет прав) — такие просто пропускаются.
        "$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match $pattern -and $(try { $_.StartTime -ge $since } catch { $false }) } | Select-Object -First 1",
        "if (-not $proc) { exit 3 }",
        "$rect = New-Object JustAIWindow+RECT",
        "[void][JustAIWindow]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)",
        "$w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top",
        "if ($w -le 0 -or $h -le 0) { exit 3 }",
        "$bmp = New-Object System.Drawing.Bitmap $w, $h",
        "$g = [System.Drawing.Graphics]::FromImage($bmp)",
        "$dc = $g.GetHdc()",
        "[void][JustAIWindow]::PrintWindow($proc.MainWindowHandle, $dc, 2)",
        "$g.ReleaseHdc($dc); $g.Dispose()",
        "$ms = New-Object System.IO.MemoryStream",
        "$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()",
        "Write-Output ('{0}|{1}|{2}' -f $proc.Id, [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($proc.MainWindowTitle)), [Convert]::ToBase64String($ms.ToArray()))",
    ].join("\n");

    const encoded = Buffer.from(script, "utf16le").toString("base64");

    return new Promise((resolve, reject) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 30_000 }, (error, stdout) => {
            if (error) {
                // Код выхода 3 — окна пока нет (execFile кладёт код выхода в error.code числом).
                if ((error as { code?: unknown }).code === 3) {
                    resolve(null);
                    return;
                }

                reject(new Error(`window capture failed: ${error.message.split("\n")[0]}`));
                return;
            }

            const [pid, encodedTitle, png] = stdout.trim().split("|");

            if (!png) {
                resolve(null);
                return;
            }

            resolve({ pid: Number(pid), windowTitle: Buffer.from(encodedTitle ?? "", "base64").toString("utf8"), png });
        });
    });
}

/** Закрыть окно программы (как кнопкой «закрыть»), а если не закрылось — завершить процесс. */
export async function closeWindowProcess(pid: number): Promise<void> {
    if (process.platform !== "win32") return;

    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow(); if (-not $p.WaitForExit(3000)) { Stop-Process -Id ${pid} -Force } }`;
    await new Promise<void>(resolve => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000 }, () => resolve()));
}
