# Bitfroest.fs

**Dual-pane file management for Visual Studio Code.**

![A glacier bridge connecting two sides of a Nordic valley](media/marketplace/bitfroest-landscape.png)

Bitfroest.fs adds two file panels to Visual Studio Code. Independent folder tabs, keyboard actions and local Git status support work across source folders, configuration files and build output.

**Beta version** – This extension is under development and may contain bugs or incomplete features.

**Risk of data loss.** File operations modify real data and may cause unintended data loss. Use copies or test data when evaluating this beta. Where possible, work in a Git repository as an additional safety net, with important changes committed before file operations. Git does not protect untracked or ignored files and does not replace a backup. Only use production data if a current backup that can be restored is available. If there is any doubt about the backup, do not use this extension on production data.

## Two folders in one view

Each panel has its own folder tabs and navigation history. Copy and move operations use the selection and the destination panel. File colors, configurable columns and directory favorites help organize frequently used locations.

![Bitfroest.fs on Windows with two file panels, file colors and Git status indicators](media/marketplace/product-overview.png)

## Features

| Area | Available functionality |
| --- | --- |
| Navigation | Two panels, independent folder tabs, history and favorites |
| File operations | Copy, move, rename, create directories and delete, with conflict handling and progress reporting |
| Inspection | File search, duplicate search and text, binary and hexadecimal viewing |
| Archives | ZIP browsing and supported archive operations |
| Development | Local Git status and opening files for editing |
| Configuration | Columns, file colors, shortcuts, tab storage and English or German interface text |

Archive support varies by format and operation. The limitations below apply to file operations and platform integration.

## Quick start

Requirements: Visual Studio Code 1.100.0 or later within the declared compatible version range. Windows is the primary supported platform.

1. Install the pre-release package supplied for the supported operating system and processor architecture.
2. Run **Bitfroest.fs: Show/hide file manager** from the Command Palette, or select its folder button in the Status Bar.
3. Open a source folder in one panel and a destination folder in the other.
4. Evaluate file operations with disposable copies before using important data.

The default opening shortcut is `Ctrl+Alt+Shift+F12` on Windows and Linux. The file manager opens in a separate compact editor window. Running the command again closes the visible file manager. Existing startup directories are used when available; otherwise, both panels open the existing user home directory. Opening the file manager does not create directories.

## Keyboard reference

| Key | Action |
| --- | --- |
| F2 / Shift+F6 | Rename the current entry |
| Ctrl+R | Refresh the file list |
| F3 | View the current file |
| F4 | Open the file for editing |
| F5 / F6 | Copy / move the selection |
| F7 | Create a directory |
| F8 | Delete using the configured deletion mode |
| Shift+F8 / Shift+Delete | Use the opposite deletion mode |
| F9 | Open a Windows Terminal tab here on Windows; open an integrated terminal on Linux |
| Ctrl+T / Ctrl+W | Open / close a folder tab |
| Alt+Left / Alt+Right | Navigate backward / forward |
| Alt+F7 | Open file search |

On Windows, F9 opens Windows PowerShell in Windows Terminal and reuses the last active terminal window. Keyboard actions apply within the relevant file manager view. Text fields and ordinary code editors retain their own bindings.

## Settings and saved layouts

Open the Visual Studio Code Settings editor and search for `Bitfroest`. Settings cover file operations, columns, favorites, colors, Git status, archive options and interface language. Tab layouts can be stored per workspace or shared across workspaces.

The file manager's **Settings** menu opens a searchable settings window. Its **Keyboard shortcuts** section supports alternative combinations, removal of bindings and restoration of defaults. Local conflicts block saving until resolved. Overrides are stored in `bitfroest.shortcuts.bindings`. An empty value disables a binding; removing an override restores the inherited value or default. External bindings and operating system shortcuts are not checked. Chords are not supported.

## Platform support and limitations

| Platform | Scope |
| --- | --- |
| Windows | Primary supported platform, including implemented native Windows integrations |
| Linux | Implemented native capabilities and portable file operations; no system file clipboard or Windows shell context menu |
| macOS | Not supported |

Unsupported operating system functions display a message in the file manager status bar when invoked.

Symbolic links and junctions are displayed but cannot be traversed or modified. Copy publication requires a filesystem that supports hard links. Before publication, copied file contents are compared with the sources using bounded buffers. This comparison does not provide an independent physical-disk integrity check.

Some archive formats, compression methods and integration features are unavailable. Cancellation may wait for the current native copy to finish on platforms without granular cancellation support. Native window and focus behavior requires broader validation.

Remote hosts, browser operation and additional processor architectures are not covered by a general compatibility claim in this documentation.

## Development

Prerequisites are Node.js, npm and Visual Studio Code compatible with the engine range in `package.json`.

```sh
npm ci
npm run check
npm run lint
npm test
```

`Start-Development.ps1` opens a development window with automatic reload. A launch configuration is also provided under `.vscode`.

## Beta packaging

The extension uses the Marketplace pre-release channel:

```sh
npm run package:beta -- --out /absolute/path/bitfroest-fs.vsix
```

The output file belongs outside the source directory. `npm run publish:beta` publishes through the configured Marketplace account and requires valid publisher credentials. Packaging and publishing require access to the packaging tool or an existing npm cache.

## License

The project is licensed under the [Apache License 2.0](LICENSE). Project attribution is recorded in [NOTICE](NOTICE). Third-party components retain their own licenses; the component list and complete license texts are included under `licenses`.

The **Licenses and acknowledgements** command opens the bundled notices inside Visual Studio Code.
