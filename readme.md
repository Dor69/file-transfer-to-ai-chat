# 🤖 File transfer to AI chat

**File transfer to AI chat** is a lightweight VS Code extension designed to effortlessly select, format, and copy your codebase files directly to AI assistants (ChatGPT, Claude, Continue, LM Studio, Telegram Bots, etc.).

No more struggling with buggy AI agents or manually opening dozens of files! Simply check the files/folders you want in the sidebar, click a button, and paste them straight into your AI chat.

---

## ✨ Features

- 📌 **Persistent Checkbox Tree:** Select files or entire folders. Checkbox selections are saved automatically across VS Code restarts!
- 📂 **Recursive Folder Selection:** Checking a parent folder automatically selects all nested subfolders and files.
- 📋 **Copy as AI Text Prompt:** Formats all checked files into a clean Markdown block with relative path headers and code blocks.
- 📁 **Copy Physical File Objects:** Copies actual OS file references to the clipboard! Allows you to press `Ctrl + V` in Telegram, Discord, or web forms to attach physical files directly.
- 🌳 **Copy ASCII Directory Tree:** Generates a clean directory tree structure to help the AI understand your project's layout.
- 📊 **Token & Size Estimator:** Calculates the estimated token count (~4 chars / token) so you know if your context fits within your LLM's context window.
- 🤖 **Status Bar Quick-Access:** Displays selected file count in the bottom status bar for instant 1-click copying.

---

## 🚀 How to Use

1. Click the **Robot Head icon 🤖** in the Activity Bar on the left side of VS Code.
2. Check the files or folders you want to include in your AI prompt.
3. Click one of the action buttons at the top right of the panel or status bar:

| Icon | Action | Description |
| :---: | :--- | :--- |
| 📋 | **Copy as AI Text Prompt** | Formats code into Markdown blocks & copies text to clipboard. |
| 📁 | **Copy File Objects** | Copies physical files to OS clipboard (ready to paste into Telegram/chat attachments). |
| 🌳 | **Copy ASCII Directory Tree** | Copies a clean directory structure tree. |
| 🔄 | **Refresh Tree** | Reloads the project file tree. |
| 🧹 | **Clear Selection** | Resets all checkboxes. |

---

## 🛠 File Export Format Example

When using **Copy as AI Text Prompt**, your code is formatted as follows:

```markdown
--- START OF FILE: core/state.py ---
class AppState:
    def __init__(self):
        self.shadow_status = "Offline"
--- END OF FILE: core/state.py ---
```

## 📦 Ignored Items

To keep your prompt clean and prevent context waste, the extension automatically ignores:
- **Folders:** `.git`, `node_modules`, `__pycache__`, `.env`, `dist`, `build`, `.vscode`, `.idea`.
- **Binary/Large Files:** Images, PDFs, archives, executables (`.png`, `.jpg`, `.pdf`, `.zip`, `.exe`, `.safetensors`, `.gguf`, etc.).

---

## 📄 License

[MIT](LICENSE)