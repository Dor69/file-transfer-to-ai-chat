const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

class FileItem extends vscode.TreeItem {
    constructor(resourceUri, isDirectory, checkboxState) {
        super(resourceUri, isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.isDirectory = isDirectory;
        this.checkboxState = checkboxState;
        this.contextValue = isDirectory ? 'folder' : 'file';
    }
}

class AIFileTreeProvider {
    constructor(workspaceState, updateStatusBarCallback) {
        this.workspaceState = workspaceState;
        this.updateStatusBar = updateStatusBarCallback;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;

        const saved = this.workspaceState.get('checkedAIFiles', []);
        this.checkedFiles = new Set(saved);

        this.ignorePatterns = ['.git', 'node_modules', '__pycache__', '.env', 'dist', 'build', '.vscode', '.idea'];
        this.ignoreExts = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.exe', '.dll', '.safetensors', '.gguf', '.ico'];
    }

    refresh() {
        this._onDidChangeTreeData.fire();
        if (this.updateStatusBar) this.updateStatusBar();
    }

    getTreeItem(element) {
        return element;
    }

    getChildren(element) {
        if (!vscode.workspace.workspaceFolders) return Promise.resolve([]);

        const dirPath = element ? element.resourceUri.fsPath : vscode.workspace.workspaceFolders[0].uri.fsPath;
        let items = [];

        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (this.ignorePatterns.some(pattern => entry.name.includes(pattern))) continue;

                const fullPath = path.join(dirPath, entry.name);
                const isDir = entry.isDirectory();

                if (!isDir) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (this.ignoreExts.includes(ext)) continue;
                }

                const uri = vscode.Uri.file(fullPath);
                const state = this.checkedFiles.has(fullPath) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;

                items.push(new FileItem(uri, isDir, state));
            }
        } catch (err) {
            console.error(err);
        }

        items.sort((a, b) => {
            if (a.isDirectory === b.isDirectory) return a.resourceUri.fsPath.localeCompare(b.resourceUri.fsPath);
            return a.isDirectory ? -1 : 1;
        });

        return Promise.resolve(items);
    }

    toggleCheck(fsPath, state) {
        const isChecked = (state === vscode.TreeItemCheckboxState.Checked);
        const isDir = fs.existsSync(fsPath) && fs.statSync(fsPath).isDirectory();

        if (isDir) {
            this.toggleFolderRecursively(fsPath, isChecked);
        } else {
            if (isChecked) {
                this.checkedFiles.add(fsPath);
            } else {
                this.checkedFiles.delete(fsPath);
            }
        }

        this.workspaceState.update('checkedAIFiles', Array.from(this.checkedFiles));
        this.refresh();
    }

    toggleFolderRecursively(dirPath, isChecked) {
        if (isChecked) {
            this.checkedFiles.add(dirPath);
        } else {
            this.checkedFiles.delete(dirPath);
        }

        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (this.ignorePatterns.some(pattern => entry.name.includes(pattern))) continue;
                const full = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    this.toggleFolderRecursively(full, isChecked);
                } else {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (!this.ignoreExts.includes(ext)) {
                        if (isChecked) {
                            this.checkedFiles.add(full);
                        } else {
                            this.checkedFiles.delete(full);
                        }
                    }
                }
            }
        } catch (err) {}
    }

    clearAll() {
        this.checkedFiles.clear();
        this.workspaceState.update('checkedAIFiles', []);
        this.refresh();
    }

    getAllSelectedFiles() {
        let files = [];
        const collect = (p) => {
            if (!fs.existsSync(p)) return;
            const stat = fs.statSync(p);
            if (stat.isDirectory()) {
                try {
                    const entries = fs.readdirSync(p, { withFileTypes: true });
                    for (const entry of entries) {
                        if (this.ignorePatterns.some(pat => entry.name.includes(pat))) continue;
                        const full = path.join(p, entry.name);
                        if (entry.isDirectory()) collect(full);
                        else {
                            const ext = path.extname(entry.name).toLowerCase();
                            if (!this.ignoreExts.includes(ext)) files.push(full);
                        }
                    }
                } catch (err) {}
            } else {
                files.push(p);
            }
        };

        this.checkedFiles.forEach(p => collect(p));
        return [...new Set(files)];
    }
}

async function activate(context) {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'aiFileTree.copyPrompt';
    statusBarItem.tooltip = 'Click to copy selected AI context';

    const updateStatusBar = () => {
        const saved = context.workspaceState.get('checkedAIFiles', []);
        if (saved.length > 0) {
            statusBarItem.text = `$(robot) AI Context: ${saved.length} items`;
            statusBarItem.show();
        } else {
            statusBarItem.hide();
        }
    };

    const provider = new AIFileTreeProvider(context.workspaceState, updateStatusBar);

    const treeView = vscode.window.createTreeView('aiFileTree', {
        treeDataProvider: provider,
        manageCheckboxStateManually: true
    });

    treeView.onDidChangeCheckboxState(e => {
        for (const [item, state] of e.items) {
            provider.toggleCheck(item.resourceUri.fsPath, state);
        }
    });

    let cmdRefresh = vscode.commands.registerCommand('aiFileTree.refresh', () => {
        provider.refresh();
    });

    let cmdClear = vscode.commands.registerCommand('aiFileTree.clear', () => {
        provider.clearAll();
        vscode.window.showInformationMessage('AI selection cleared.');
    });

    let cmdCopyPrompt = vscode.commands.registerCommand('aiFileTree.copyPrompt', async () => {
        const files = provider.getAllSelectedFiles();
        if (files.length === 0) {
            return vscode.window.showWarningMessage('Please select files or folders first.');
        }

        let result = '';
        let totalChars = 0;
        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;

        for (const file of files) {
            try {
                const content = fs.readFileSync(file, 'utf8');
                totalChars += content.length;
                const relativePath = path.relative(workspacePath, file);
                const ext = path.extname(file).replace('.', '') || 'text';

                result += `\n\n--- START OF FILE: ${relativePath} ---\n`;
                result += '```' + ext + '\n';
                result += content;
                result += '\n```\n';
                result += `--- END OF FILE: ${relativePath} ---\n`;
            } catch (err) {}
        }

        const estimatedTokens = Math.ceil(totalChars / 4);
        await vscode.env.clipboard.writeText(result.trim());
        vscode.window.showInformationMessage(`📋 Copied ${files.length} files (~${estimatedTokens} tokens) to clipboard!`);
    });

    let cmdCopyFiles = vscode.commands.registerCommand('aiFileTree.copyFiles', async () => {
        const files = provider.getAllSelectedFiles();
        if (files.length === 0) {
            return vscode.window.showWarningMessage('Please select files or folders first.');
        }

        const formattedPaths = files.map(f => `'${f}'`).join(',');
        const psCommand = `powershell -Command "Set-Clipboard -Path ${formattedPaths}"`;

        exec(psCommand, (error) => {
            if (error) {
                vscode.window.showErrorMessage('Failed to copy files to clipboard.');
            } else {
                vscode.window.showInformationMessage(`📁 Copied ${files.length} physical file objects! Ready to paste.`);
            }
        });
    });

    let cmdCopyTree = vscode.commands.registerCommand('aiFileTree.copyTree', async () => {
        const files = provider.getAllSelectedFiles();
        if (files.length === 0) {
            return vscode.window.showWarningMessage('Please select files or folders first.');
        }

        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        let relativePaths = files.map(f => path.relative(workspacePath, f));
        relativePaths.sort();

        let treeText = `Project Structure (${files.length} files selected):\n`;
        relativePaths.forEach(p => {
            treeText += `├── ${p}\n`;
        });

        await vscode.env.clipboard.writeText(treeText.trim());
        vscode.window.showInformationMessage('🌳 ASCII Project Structure copied to clipboard!');
    });

    updateStatusBar();
    context.subscriptions.push(cmdRefresh, cmdClear, cmdCopyPrompt, cmdCopyFiles, cmdCopyTree, statusBarItem);
}

function deactivate() {}

module.exports = { activate, deactivate };