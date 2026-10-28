import { execFile } from 'node:child_process';
import path from 'node:path';

let choosing = false;

async function showDirectoryDialog(initial: string): Promise<string> {
    if (process.platform !== 'win32') throw new Error('浏览文件夹需要在 Windows 电脑上运行本机服务。');
    const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $initial=[Console]::In.ReadToEnd(); $owner=New-Object System.Windows.Forms.Form; $owner.ShowInTaskbar=$false; $owner.TopMost=$true; $owner.Opacity=0; $dialog=New-Object System.Windows.Forms.FolderBrowserDialog; try { $dialog.Description='选择 CtrlWrite 工作区文件夹'; $dialog.ShowNewFolderButton=$true; if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $dialog.SelectedPath=$initial }; $owner.Show(); if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) } } finally { $dialog.Dispose(); $owner.Dispose() }`;
    return new Promise((resolve, reject) => {
        const child = execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 300000, maxBuffer: 65536 }, (error, stdout) => {
            if (error) reject(new Error(error.killed ? '文件夹选择已超时，请重新点击浏览文件夹。' : '无法打开文件夹选择窗口，请确认本机服务运行在当前 Windows 桌面中。'));
            else resolve(stdout.trim());
        });
        child.stdin!.on('error', () => undefined);
        child.stdin!.end(initial);
    });
}

export async function selectWorkspaceDirectory(initial: unknown = '', show = showDirectoryDialog): Promise<string | null> {
    if (typeof initial !== 'string' || initial.length > 32767) throw new Error('工作区路径无效。');
    if (choosing) throw new Error('已有文件夹选择窗口，请先完成或取消选择。');
    choosing = true;
    try {
        const selected = await show(initial);
        if (!selected) return null;
        if (!path.isAbsolute(selected)) throw new Error('请选择有效的文件夹绝对路径。');
        return selected;
    } finally { choosing = false; }
}
