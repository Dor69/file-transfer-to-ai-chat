const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');

const VIEW_ID = 'aiFileTree';
const STATE_KEY = 'checkedAIFiles';
const CONFIG_SECTION = 'fileTransferToAI';
const EXPANDED_CONTEXT = 'aiFileTree.expanded';

const LANGUAGE_MAP = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
    py: 'python', pyi: 'python', rb: 'ruby', rs: 'rust', go: 'go',
    java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', cs: 'csharp',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', h: 'c', c: 'c',
    m: 'objectivec', mm: 'objectivec', swift: 'swift', dart: 'dart',
    php: 'php', lua: 'lua', r: 'r', pl: 'perl', ex: 'elixir', exs: 'elixir',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish', ps1: 'powershell', bat: 'batch', cmd: 'batch',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini',
    json: 'json', jsonc: 'jsonc', xml: 'xml', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    vue: 'vue', svelte: 'svelte', astro: 'astro',
    md: 'markdown', mdx: 'mdx', sql: 'sql', graphql: 'graphql', gql: 'graphql',
    proto: 'protobuf', tf: 'hcl', hcl: 'hcl', gradle: 'groovy', groovy: 'groovy'
};

const SPECIAL_FILES = {
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    'cmakelists.txt': 'cmake',
    gemfile: 'ruby',
    rakefile: 'ruby',
    jenkinsfile: 'groovy'
};

const MAC_COPY_SCRIPT = `function run(argv) {
    ObjC.import('AppKit');
    const pb = $.NSPasteboard.generalPasteboard;
    pb.clearContents;
    const urls = argv.map(p => $.NSURL.fileURLWithPath(p));
    if (!pb.writeObjects($(urls))) {
        throw new Error('NSPasteboard writeObjects failed');
    }
    return 'ok';
}`;

function getConfig() {
    const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
        ignoreNames: c.get('ignoreNames', []),
        ignoreExtensions: c.get('ignoreExtensions', []).map(e => String(e).toLowerCase()),
        maxFileSizeKB: c.get('maxFileSizeKB', 1024),
        includeTreeInPrompt: c.get('includeTreeInPrompt', true),
        openFileOnClick: c.get('openFileOnClick', true)
    };
}

function globToRegex(pattern) {
    const escaped = String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, process.platform === 'linux' ? '' : 'i');
}

function safeStat(p) {
    try {
        return fs.statSync(p);
    } catch {
        return null;
    }
}

function isBinary(buffer) {
    const len = Math.min(buffer.length, 8000);
    for (let i = 0; i < len; i++) {
        if (buffer[i] === 0) return true;
    }
    return false;
}

function makeFence(content) {
    const runs = content.match(/`{3,}/g);
    const longest = runs ? Math.max(...runs.map(r => r.length)) : 0;
    return '`'.repeat(Math.max(3, longest + 1));
}

function getLanguage(file) {
    const base = path.basename(file).toLowerCase();
    if (SPECIAL_FILES[base]) return SPECIAL_FILES[base];
    const ext = path.extname(base).slice(1);
    return LANGUAGE_MAP[ext] || ext || 'text';
}

function isMultiRoot() {
    return (vscode.workspace.workspaceFolders || []).length > 1;
}

function toRelative(file) {
    return vscode.workspace.asRelativePath(vscode.Uri.file(file), isMultiRoot());
}

function formatTokens(n) {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.round(n));
}

function compareNames(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function buildTree(files) {
    const root = Object.create(null);
    for (const file of files) {
        const parts = toRelative(file).split('/').filter(Boolean);
        let node = root;
        parts.forEach((part, i) => {
            if (i === parts.length - 1) {
                if (!(part in node)) node[part] = null;
            } else {
                if (!node[part]) node[part] = Object.create(null);
                node = node[part];
            }
        });
    }

    const lines = [];
    const walk = (node, prefix) => {
        const keys = Object.keys(node).sort((a, b) => {
            const aDir = node[a] !== null;
            const bDir = node[b] !== null;
            if (aDir !== bDir) return aDir ? -1 : 1;
            return compareNames(a, b);
        });
        keys.forEach((key, i) => {
            const last = i === keys.length - 1;
            const isDir = node[key] !== null;
            lines.push(`${prefix}${last ? '└── ' : '├── '}${key}${isDir ? '/' : ''}`);
            if (isDir) walk(node[key], prefix + (last ? '    ' : '│   '));
        });
    };
    walk(root, '');

    const folders = vscode.workspace.workspaceFolders || [];
    const rootLabel = folders.length === 1 ? folders[0].name : (vscode.workspace.name || 'workspace');
    return `Project Structure (${files.length} files selected):\n${rootLabel}/\n${lines.join('\n')}`;
}

async function buildPrompt(files, config) {
    const maxBytes = config.maxFileSizeKB > 0 ? config.maxFileSizeKB * 1024 : Infinity;
    const parts = [];
    const included = [];
    const skipped = { binary: [], large: [], failed: [] };

    for (const file of files) {
        let buffer;
        try {
            const stat = await fs.promises.stat(file);
            if (stat.size > maxBytes) {
                skipped.large.push(file);
                continue;
            }
            buffer = await fs.promises.readFile(file);
        } catch {
            skipped.failed.push(file);
            continue;
        }

        if (isBinary(buffer)) {
            skipped.binary.push(file);
            continue;
        }

        let content = buffer.toString('utf8');
        if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
        content = content.replace(/\r\n/g, '\n');
        if (!content.endsWith('\n')) content += '\n';

        const rel = toRelative(file);
        const fence = makeFence(content);
        parts.push(
            `--- START OF FILE: ${rel} ---\n` +
            `${fence}${getLanguage(file)}\n${content}${fence}\n` +
            `--- END OF FILE: ${rel} ---`
        );
        included.push(file);
    }

    let text = parts.join('\n\n');
    if (config.includeTreeInPrompt && included.length > 0) {
        text = `${buildTree(included)}\n\n${text}`;
    }

    return { text, included, skipped };
}

function describeSkipped(skipped, config) {
    const notes = [];
    if (skipped.binary.length) notes.push(`${skipped.binary.length} binary`);
    if (skipped.large.length) notes.push(`${skipped.large.length} larger than ${config.maxFileSizeKB} KB`);
    if (skipped.failed.length) notes.push(`${skipped.failed.length} unreadable`);
    return notes.length ? ` Skipped: ${notes.join(', ')}.` : '';
}

function execFileAsync(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(new Error((stderr && stderr.trim()) || error.message));
            else resolve(stdout);
        });
    });
}

function spawnWithInput(cmd, args, input) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        } catch (err) {
            reject(err);
            return;
        }
        child.on('error', reject);
        child.on('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

async function copyFilesWindows(files) {
    const listFile = path.join(os.tmpdir(), `ai-file-transfer-${process.pid}-${Date.now()}.txt`);
    await fs.promises.writeFile(listFile, '\uFEFF' + files.join('\r\n'), 'utf8');
    const escaped = listFile.replace(/'/g, "''");
    const script = `$ErrorActionPreference = 'Stop'; $p = @(Get-Content -LiteralPath '${escaped}' -Encoding UTF8); Set-Clipboard -LiteralPath $p`;
    try {
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    } finally {
        fs.promises.unlink(listFile).catch(() => {});
    }
}

async function copyFilesMac(files) {
    await execFileAsync('osascript', ['-l', 'JavaScript', '-e', MAC_COPY_SCRIPT, ...files]);
}

async function copyFilesLinux(files) {
    const uriList = files.map(f => pathToFileURL(f).href).join('\r\n') + '\r\n';
    const attempts = [];
    if (process.env.WAYLAND_DISPLAY) attempts.push(['wl-copy', ['--type', 'text/uri-list']]);
    attempts.push(['xclip', ['-selection', 'clipboard', '-t', 'text/uri-list']]);
    if (!process.env.WAYLAND_DISPLAY) attempts.push(['wl-copy', ['--type', 'text/uri-list']]);

    let lastError;
    for (const [cmd, args] of attempts) {
        try {
            await spawnWithInput(cmd, args, uriList);
            return;
        } catch (err) {
            lastError = err;
        }
    }
    throw new Error(`Install xclip (X11) or wl-clipboard (Wayland). ${lastError ? lastError.message : ''}`.trim());
}

function copyFilesToClipboard(files) {
    switch (process.platform) {
        case 'win32': return copyFilesWindows(files);
        case 'darwin': return copyFilesMac(files);
        default: return copyFilesLinux(files);
    }
}

class FileItem extends vscode.TreeItem {
    constructor(fsPath, isDirectory, options) {
        const collapsible = isDirectory
            ? (options.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
            : vscode.TreeItemCollapsibleState.None;
        const uri = vscode.Uri.file(fsPath);
        super(uri, collapsible);

        this.fsPath = fsPath;
        this.isDirectory = isDirectory;
        this.id = `${options.generation}:${fsPath}`;
        this.contextValue = isDirectory ? 'aiFolder' : 'aiFile';
        this.checkboxState = options.checked
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;

        if (options.label) this.label = options.label;
        if (options.description) this.description = options.description;

        if (!isDirectory && options.openOnClick) {
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [uri, { preview: true, preserveFocus: true }]
            };
        }
    }
}

class AIFileTreeProvider {
    constructor(context) {
        this.context = context;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this._onDidChangeSelection = new vscode.EventEmitter();
        this.onDidChangeSelection = this._onDidChangeSelection.event;

        this.generation = 0;
        this.expanded = false;
        this.dirCache = new Map();
        this.checkedFiles = new Set();

        this.loadConfig();
        this.restore();
    }

    loadConfig() {
        this.config = getConfig();
        this.nameMatchers = this.config.ignoreNames.map(globToRegex);
        this.ignoreExts = new Set(this.config.ignoreExtensions);
        this.dirCache.clear();
    }

    restore() {
        const saved = this.context.workspaceState.get(STATE_KEY, []);
        let migrated = false;
        for (const p of saved) {
            const stat = safeStat(p);
            if (!stat) {
                migrated = true;
                continue;
            }
            if (stat.isDirectory()) {
                for (const f of this.collectFiles(p)) this.checkedFiles.add(f);
                migrated = true;
            } else if (stat.isFile()) {
                this.checkedFiles.add(p);
            }
        }
        if (migrated) this.persist();
    }

    persist() {
        return this.context.workspaceState.update(STATE_KEY, Array.from(this.checkedFiles));
    }

    commit() {
        this.persist();
        this._onDidChangeTreeData.fire();
        this._onDidChangeSelection.fire();
    }

    refresh() {
        this.dirCache.clear();
        this._onDidChangeTreeData.fire();
        this._onDidChangeSelection.fire();
    }

    setExpanded(expanded) {
        this.expanded = expanded;
        this.generation++;
        vscode.commands.executeCommand('setContext', EXPANDED_CONTEXT, expanded);
        this._onDidChangeTreeData.fire();
    }

    isIgnored(name, isDir) {
        if (this.nameMatchers.some(rx => rx.test(name))) return true;
        if (!isDir && this.ignoreExts.has(path.extname(name).toLowerCase())) return true;
        return false;
    }

    readDir(dirPath) {
        let entries;
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch {
            return [];
        }

        const result = [];
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            let isDir = entry.isDirectory();
            let isFile = entry.isFile();

            if (entry.isSymbolicLink()) {
                const stat = safeStat(fullPath);
                if (!stat || stat.isDirectory()) continue;
                isFile = stat.isFile();
            }

            if (!isDir && !isFile) continue;
            if (this.isIgnored(entry.name, isDir)) continue;
            result.push({ name: entry.name, fullPath, isDir });
        }

        result.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return compareNames(a.name, b.name);
        });
        return result;
    }

    collectFiles(dirPath) {
        const cached = this.dirCache.get(dirPath);
        if (cached) return cached;

        const files = [];
        for (const entry of this.readDir(dirPath)) {
            if (entry.isDir) {
                for (const f of this.collectFiles(entry.fullPath)) files.push(f);
            } else {
                files.push(entry.fullPath);
            }
        }
        this.dirCache.set(dirPath, files);
        return files;
    }

    getTreeItem(element) {
        return element;
    }

    getChildren(element) {
        const folders = vscode.workspace.workspaceFolders || [];
        if (!element) {
            if (folders.length === 0) return [];
            if (folders.length === 1) return this.buildItems(folders[0].uri.fsPath);
            return folders.map(f => this.createItem(f.uri.fsPath, true, f.name));
        }
        return this.buildItems(element.fsPath);
    }

    buildItems(dirPath) {
        return this.readDir(dirPath).map(e => this.createItem(e.fullPath, e.isDir));
    }

    createItem(fsPath, isDir, label) {
        let checked;
        let description;

        if (isDir) {
            const files = this.collectFiles(fsPath);
            let count = 0;
            for (const f of files) {
                if (this.checkedFiles.has(f)) count++;
            }
            checked = files.length > 0 && count === files.length;
            if (count > 0 && !checked) description = `${count}/${files.length}`;
        } else {
            checked = this.checkedFiles.has(fsPath);
        }

        return new FileItem(fsPath, isDir, {
            checked,
            description,
            label,
            expanded: this.expanded,
            generation: this.generation,
            openOnClick: this.config.openFileOnClick
        });
    }

    applyCheck(paths, checked) {
        let changed = 0;
        for (const p of paths) {
            const stat = safeStat(p);

            if (!checked) {
                const prefix = p.endsWith(path.sep) ? p : p + path.sep;
                for (const f of Array.from(this.checkedFiles)) {
                    if (f === p || f.startsWith(prefix)) {
                        this.checkedFiles.delete(f);
                        changed++;
                    }
                }
                continue;
            }

            if (!stat) continue;
            const targets = stat.isDirectory() ? this.collectFiles(p) : (stat.isFile() ? [p] : []);
            for (const f of targets) {
                if (!this.checkedFiles.has(f)) {
                    this.checkedFiles.add(f);
                    changed++;
                }
            }
        }
        return changed;
    }

    setChecked(paths, checked) {
        const changed = this.applyCheck(paths, checked);
        if (changed > 0) this.commit();
        return changed;
    }

    selectAll() {
        const folders = vscode.workspace.workspaceFolders || [];
        this.dirCache.clear();
        return this.setChecked(folders.map(f => f.uri.fsPath), true);
    }

    clearAll() {
        const count = this.checkedFiles.size;
        this.checkedFiles.clear();
        this.commit();
        return count;
    }

    pruneMissing() {
        let changed = false;
        for (const f of Array.from(this.checkedFiles)) {
            if (!fs.existsSync(f)) {
                this.checkedFiles.delete(f);
                changed = true;
            }
        }
        if (changed) this.persist();
        return changed;
    }

    getSelectedFiles() {
        return Array.from(this.checkedFiles)
            .filter(f => {
                const stat = safeStat(f);
                return stat && stat.isFile();
            })
            .sort((a, b) => compareNames(toRelative(a), toRelative(b)));
    }
}

function collectUris(uri, uris) {
    if (Array.isArray(uris) && uris.length > 0) return uris;
    if (uri instanceof vscode.Uri) return [uri];
    const active = vscode.window.activeTextEditor;
    return active ? [active.document.uri] : [];
}

function collectOpenEditorPaths() {
    const paths = new Set();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input instanceof vscode.TabInputText && input.uri.scheme === 'file') {
                paths.add(input.uri.fsPath);
            } else if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === 'file') {
                paths.add(input.modified.fsPath);
            }
        }
    }
    return Array.from(paths);
}

async function collectGitChangedPaths() {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) throw new Error('Built-in Git extension is not available.');
    const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const git = exports.getAPI(1);

    const paths = new Set();
    for (const repo of git.repositories) {
        const state = repo.state;
        const changes = [
            ...(state.workingTreeChanges || []),
            ...(state.indexChanges || []),
            ...(state.untrackedChanges || [])
        ];
        for (const change of changes) {
            if (change.uri && change.uri.scheme === 'file') paths.add(change.uri.fsPath);
        }
    }
    return Array.from(paths);
}

async function activate(context) {
    const provider = new AIFileTreeProvider(context);
    vscode.commands.executeCommand('setContext', EXPANDED_CONTEXT, false);

    const treeView = vscode.window.createTreeView(VIEW_ID, {
        treeDataProvider: provider,
        manageCheckboxStateManually: true,
        canSelectMany: true
    });

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'aiFileTree.copyPrompt';

    const updateStatusBar = () => {
        const files = provider.getSelectedFiles();
        if (files.length === 0) {
            statusBarItem.hide();
            treeView.badge = undefined;
            treeView.description = undefined;
            return;
        }

        let bytes = 0;
        for (const f of files) {
            const stat = safeStat(f);
            if (stat) bytes += stat.size;
        }
        const tokens = formatTokens(bytes / 4);

        statusBarItem.text = `$(robot) AI: ${files.length} files · ~${tokens}`;
        statusBarItem.tooltip = `${files.length} files selected (~${tokens} tokens)\nClick to copy as AI prompt`;
        statusBarItem.show();
        treeView.badge = { value: files.length, tooltip: `${files.length} files selected` };
        treeView.description = `~${tokens} tokens`;
    };

    context.subscriptions.push(
        treeView,
        statusBarItem,
        provider.onDidChangeSelection(updateStatusBar),
        treeView.onDidChangeCheckboxState(e => {
            let changed = 0;
            for (const [item, state] of e.items) {
                changed += provider.applyCheck([item.fsPath], state === vscode.TreeItemCheckboxState.Checked);
            }
            if (changed > 0) provider.commit();
            else provider.refresh();
        })
    );

    const register = (id, handler) => {
        context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
            try {
                await handler(...args);
            } catch (err) {
                vscode.window.showErrorMessage(`File transfer to AI chat: ${err && err.message ? err.message : err}`);
            }
        }));
    };

    const requireSelection = () => {
        const files = provider.getSelectedFiles();
        if (files.length === 0) {
            vscode.window.showWarningMessage('Please select files or folders first.');
            return null;
        }
        return files;
    };

    const generatePrompt = files => vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Building AI prompt…' },
        () => buildPrompt(files, provider.config)
    );

    register('aiFileTree.copyPrompt', async () => {
        const files = requireSelection();
        if (!files) return;

        const { text, included, skipped } = await generatePrompt(files);
        if (included.length === 0) {
            vscode.window.showWarningMessage(`No text files to copy.${describeSkipped(skipped, provider.config)}`);
            return;
        }

        await vscode.env.clipboard.writeText(text);
        const tokens = formatTokens(text.length / 4);
        vscode.window.showInformationMessage(
            `📋 Copied ${included.length} files (~${tokens} tokens) to clipboard.${describeSkipped(skipped, provider.config)}`
        );
    });

    register('aiFileTree.openPrompt', async () => {
        const files = requireSelection();
        if (!files) return;

        const { text, included, skipped } = await generatePrompt(files);
        if (included.length === 0) {
            vscode.window.showWarningMessage(`No text files to show.${describeSkipped(skipped, provider.config)}`);
            return;
        }

        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: false });
    });

    register('aiFileTree.copyFiles', async () => {
        const files = requireSelection();
        if (!files) return;

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Copying file objects…' },
            () => copyFilesToClipboard(files)
        );
        vscode.window.showInformationMessage(`📁 Copied ${files.length} file objects. Ready to paste.`);
    });

    register('aiFileTree.copyTree', async () => {
        const files = requireSelection();
        if (!files) return;

        await vscode.env.clipboard.writeText(buildTree(files));
        vscode.window.showInformationMessage('🌳 Directory tree copied to clipboard.');
    });

    register('aiFileTree.selectAll', () => {
        const added = provider.selectAll();
        vscode.window.setStatusBarMessage(`$(check-all) Selected ${provider.checkedFiles.size} files (+${added})`, 3000);
    });

    register('aiFileTree.selectOpenEditors', () => {
        const paths = collectOpenEditorPaths();
        if (paths.length === 0) {
            vscode.window.showInformationMessage('No open file editors.');
            return;
        }
        const added = provider.setChecked(paths, true);
        vscode.window.setStatusBarMessage(`$(check) Added ${added} open files`, 3000);
    });

    register('aiFileTree.selectGitChanges', async () => {
        const paths = await collectGitChangedPaths();
        if (paths.length === 0) {
            vscode.window.showInformationMessage('No Git changes found.');
            return;
        }
        const added = provider.setChecked(paths, true);
        vscode.window.setStatusBarMessage(`$(git-commit) Added ${added} changed files`, 3000);
    });

    register('aiFileTree.clear', () => {
        provider.clearAll();
        vscode.window.setStatusBarMessage('$(clear-all) AI selection cleared', 3000);
    });

    register('aiFileTree.expandAll', () => provider.setExpanded(true));
    register('aiFileTree.collapseAll', () => provider.setExpanded(false));
    register('aiFileTree.refresh', () => {
        provider.pruneMissing();
        provider.refresh();
    });

    register('aiFileTree.addToContext', (uri, uris) => {
        const targets = collectUris(uri, uris).filter(u => u.scheme === 'file').map(u => u.fsPath);
        if (targets.length === 0) return;
        const added = provider.setChecked(targets, true);
        vscode.window.setStatusBarMessage(`$(add) Added ${added} files to AI context`, 3000);
    });

    register('aiFileTree.removeFromContext', (uri, uris) => {
        const targets = collectUris(uri, uris).filter(u => u.scheme === 'file').map(u => u.fsPath);
        if (targets.length === 0) return;
        const removed = provider.setChecked(targets, false);
        vscode.window.setStatusBarMessage(`$(remove) Removed ${removed} files from AI context`, 3000);
    });

    register('aiFileTree.revealInExplorer', item => {
        if (item && item.resourceUri) {
            return vscode.commands.executeCommand('revealInExplorer', item.resourceUri);
        }
    });

    let refreshTimer;
    let statusTimer;
    let pendingPrune = false;

    const scheduleRefresh = prune => {
        if (prune) pendingPrune = true;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            if (pendingPrune) provider.pruneMissing();
            pendingPrune = false;
            provider.refresh();
        }, 400);
    };

    const scheduleStatus = () => {
        clearTimeout(statusTimer);
        statusTimer = setTimeout(updateStatusBar, 800);
    };

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    context.subscriptions.push(
        watcher,
        watcher.onDidCreate(() => scheduleRefresh(false)),
        watcher.onDidDelete(() => scheduleRefresh(true)),
        watcher.onDidChange(scheduleStatus),
        vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRefresh(true)),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(CONFIG_SECTION)) {
                provider.loadConfig();
                provider.refresh();
            }
        }),
        { dispose: () => { clearTimeout(refreshTimer); clearTimeout(statusTimer); } }
    );

    updateStatusBar();
}

function deactivate() {}

module.exports = { activate, deactivate };