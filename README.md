# Bitfroest.fs

[![Marketplace version](https://vsmarketplacebadges.dev/version/bitfroest.bitfroest-fs-prototype.svg)](https://marketplace.visualstudio.com/items?itemName=bitfroest.bitfroest-fs-prototype)
[![Marketplace downloads](https://vsmarketplacebadges.dev/downloads/bitfroest.bitfroest-fs-prototype.svg)](https://marketplace.visualstudio.com/items?itemName=bitfroest.bitfroest-fs-prototype)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs/bitfroest.bitfroest-fs-prototype.svg)](https://marketplace.visualstudio.com/items?itemName=bitfroest.bitfroest-fs-prototype)
[![Build: main](https://github.com/s-a/Bitfroest.fs/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/s-a/Bitfroest.fs/actions/workflows/release.yml?query=branch%3Amain)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**A two-panel file manager for Visual Studio Code.** File operations, folder tabs and Git views share a compact editor window.

![Create and organize handover notes](media/marketplace/showcases/0010-windows-en-dark-new-file-story.gif)

**Beta version** — This extension is under development and may contain bugs or incomplete features.

## Get started

Requires Visual Studio Code 1.100.0 or later within the declared compatible version range. Install the pre-release package for a supported operating system and processor. The Command Palette entry **Bitfroest.fs: Show/hide file manager** or its folder button in the Status Bar opens the file manager.

The default shortcut is `Ctrl+Alt+Shift+F12` on Windows and Linux. Repeating the command closes the window. Each panel has its own folder tabs and navigation history. Keyboard shortcuts can be customized in VS Code.

When the file system refuses a deletion, the file manager identifies the affected entry and reports how many entries were already deleted. **Inspect file locks** opens the lock inspector on Windows and Linux.

<!-- showcase-gallery:start -->
## Feature walkthrough

Windows examples with isolated sample files.

### Basic File Operations

<details>
<summary><kbd>F7</kbd> <kbd>F5</kbd> <kbd>F2</kbd> Prepare a project handover</summary>

![Create a handover folder, review the copy dialog, and rename the copied file](media/marketplace/showcases/0009-windows-en-dark-new-folder-handover.gif)

</details>

<details>
<summary><kbd>Shift+F4</kbd> <kbd>Ctrl+A</kbd> <kbd>F6</kbd> <kbd>Ctrl+M</kbd> <kbd>Ctrl+Numpad-</kbd> Create and organize handover notes</summary>

![Create and organize handover notes](media/marketplace/showcases/0010-windows-en-dark-new-file-story.gif)

</details>

<details>
<summary><kbd>F8</kbd> <kbd>Shift+F8</kbd> Remove temporary files</summary>

![Remove temporary files](media/marketplace/showcases/0011-windows-en-dark-delete-confirmations-cleanup.gif)

</details>

### File &amp; Folder Locks

<details>
<summary><kbd>Shift+F8</kbd> <kbd>F5</kbd> Find the process using a locked file</summary>

![Find the process using a locked file](media/marketplace/showcases/0022-windows-en-dark-folder-locks-story.gif)

</details>

<!-- showcase-gallery:end -->

## Configuration

The **Configuration** menu opens settings for file operations, favorites, columns and shortcuts. Additional options are available by searching for `Bitfroest` in VS Code Settings. Tab layouts can be stored per workspace or shared across workspaces.

## Platform support

| Platform | Support |
| --- | --- |
| Windows | Primary supported platform, including native Windows integrations |
| Linux | Native file copy, symbolic links, Git index actions, supported desktop capabilities and portable file operations. File clipboard access uses X11, supported Wayland data-control protocols or an existing XWayland connection. The Windows shell context menu is unavailable |
| macOS | Experimental Marketplace pre-release for Apple Silicon (ARM64). Build and package checks run in CI. Desktop workflows are open for community testing |

Published Windows and Linux packages target x64 processors. Linux packages target Ubuntu 24.04 or a compatible newer runtime.

On Apple Silicon, select **Install Pre-Release Version** in the VS Code Extensions view. Use disposable files for testing. The system file clipboard, native context menu, opening files in their associated applications, and the Trash view are unavailable on macOS. Include the macOS, VS Code, and extension versions and steps to reproduce when reporting an issue. [Report a bug](https://github.com/s-a/Bitfroest.fs/issues/new?template=bug-report.yml)

Native folder icons on Linux require GIO, GdkPixbuf and installed image loaders. SVG icons require the librsvg loader. On Ubuntu, these runtime components are provided by `libglib2.0-0t64`, `libgdk-pixbuf-2.0-0`, `librsvg2-common` and `shared-mime-info`.

Linux copies preserve symbolic links as links, including relative and dangling targets. Explicitly opening a directory link navigates to its canonical target within the permitted roots. Recursive copy and deletion do not traverse link targets. Copy publication does not require hardlinks. Native copying preserves file and directory permissions, ownership, timestamps, extended attributes and POSIX ACLs when the filesystem and current permissions allow them; metadata failures are reported. Sparse files retain holes where the filesystem exposes data and hole ranges. Symbolic-link extended attributes require an API that can address the held link identity; copying a link carrying such attributes currently reports an unsupported-metadata error.

Linux file clipboard access uses the current extension host's desktop session. It requires `libxcb.so.1` with `libxcb-xfixes.so.0`, or `libwayland-client.so.0` with permission to use `ext-data-control-v1` or `wlr-data-control`. Wayland sessions without these protocols can use an already running XWayland server identified through its public extension; the extension does not start XWayland. Private integration tests cover Mutter 46.2 through XWayland and KWin 5.27 through data control. A named Wayland display is required; an inherited `WAYLAND_SOCKET` connection is not shared between native sessions. Sessions exposing neither permitted data control nor XWayland cannot provide system file clipboard access. Internal copy and paste remain available.

A completed move is confirmed by the file-operation backend. Partial completion updates the payload served by the owned clipboard source; clients that have already cached its contents receive no guaranteed refresh notification. Another application consuming a cut selection does not provide a standardized move-completion notification. Clipboard contents published by the extension remain available while their native session is active.

When an operating system function is unavailable, the file manager reports it in its lower status bar when that function is used. VS Code remote hosts, browser use and processor architectures beyond the published packages are not covered by a general compatibility claim.

## Beta notice

**Use at your own risk.** The software is provided as is, without warranties, to the extent permitted by applicable law. Warranty and liability are governed by the Apache License 2.0, in particular Sections 7 and 8. Mandatory statutory rights remain unaffected.

**Risk of data loss.** File operations modify real data and may cause unintended data loss. Use copies or test data when evaluating this beta. Where possible, work in a Git repository as an additional safety net, with important changes committed before file operations. Git does not protect untracked or ignored files and does not replace a backup. Only use production data if a current backup that can be restored is available. If there is any doubt about the backup, do not use this extension on production data.

## Features and default shortcuts

Shortcuts apply to the file manager unless a different context is stated. They can be customized in **Configuration → Shortcuts**. A dash indicates that no default shortcut is assigned.

| Area | Feature | Default shortcut |
| --- | --- | --- |
| File operations | Create a folder | `F7` |
| File operations | Create a folder in the opposite pane | `Shift+F7` |
| File operations | Create a text file | `Shift+F4` |
| File operations | Copy / move selected entries | `F5` / `F6` |
| File operations | Copy in the current folder | `Shift+F5` |
| File operations | Rename an entry / multi-rename | `F2` or `Shift+F6` / `Ctrl+M` |
| File operations | Delete / use the alternate deletion mode | `F8` or `Delete` / `Shift+F8` or `Shift+Delete` |
| File operations | Copy, cut and paste files | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` |
| File operations | Open the recycle bin | — |
| File operations | Inspect folder locks and references | — |
| File operations | Open the operating system context menu (Windows; when enabled in settings) | `Shift+F10` |
| Navigation | Switch panes / open an entry / go to the parent folder | `Tab` / `Enter` / `Backspace` |
| Navigation | Enter a path / open a path from the clipboard | `Ctrl+L` / `Ctrl+Shift+L` |
| Navigation | Previous / next folder in history | `Alt+Left` / `Alt+Right` |
| Navigation | Open favorites | `Ctrl+D` |
| Navigation | Create / close a folder tab | `Ctrl+T` / `Ctrl+W` |
| Navigation | Next / previous folder tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Navigation | Open the folder under the cursor in a new tab / in the opposite pane | `Ctrl+Up` / `Ctrl+Shift+Up` |
| Navigation | Create a background folder tab | `Ctrl+Shift+T` |
| Navigation | Swap current paths / swap panes | `Ctrl+U` / `Ctrl+Shift+U` |
| Navigation | Refresh the file list | `Ctrl+R` |
| Selection | Toggle selection / toggle and move to the next entry | `Space` / `Insert` |
| Selection | Select all / clear selection | `Ctrl+A` / `Ctrl+Numpad-` |
| Selection | Select / unselect a group | `Numpad+` / `Numpad-` |
| Selection | Invert / restore selection | `Numpad*` / `Numpad/` |
| Selection | Select / unselect files with the same extension | `Ctrl+Numpad+` or `Alt+Numpad+` / `Alt+Numpad-` |
| Selection | Save a selection in memory or a file; load a saved selection | — |
| Selection | Copy selected names, paths or details as text | `Ctrl+Y` for paths; `Ctrl+Shift+Y` for paths with forward slashes |
| Search | Find files / search in a separate window | `Alt+F7` / `Alt+Shift+F7` |
| Search | Search the current file list | `Ctrl+F` |
| Search | Select matches / show only matches | `Ctrl+B` / `Ctrl+Shift+F` |
| Archives | Browse ZIP archives | — |
| Archives | Pack / pack and remove sources | `Alt+F5` / `Alt+Shift+F5` |
| Archives | Unpack / test ZIP archives | `Alt+F9` or `Alt+F6` / `Alt+Shift+F9` |
| View | View / edit a file | `F3` / `F4` |
| View | Search within the file viewer | `F7` or `Ctrl+F` in the viewer |
| View | X-Ray preview / Quick Diff | — |
| View | Sort by name, extension, date or size | — |
| View | Calculate folder sizes | `Alt+Shift+Enter` |
| View | Configure columns and file colors | — |
| Git | Show repository status, branches, diff and history | — |
| Git | Remove a file from the Git index or remove it and add it to the ignore list | — |
| Tools | Open a terminal in the current folder | `F9` |
| Tools | Show / hide the file manager | `Ctrl+Alt+Shift+F12` |

## License and support

Licensed under the [Apache License 2.0](LICENSE). Project attribution is recorded in [NOTICE](NOTICE); third-party component licenses are included under `licenses`. Use the [GitHub issue tracker](https://github.com/s-a/Bitfroest.fs/issues) for project support and bug reports.

**Report on GitHub** in a file operation error dialog opens a prefilled issue for review. The report includes a shortened error message, error codes and version information. Recognized paths retain up to three trailing components, which may contain names. Recognized URLs are masked. Stack traces and panel paths are excluded.

Community testing, contributions and feedback are welcome and appreciated. Linux bug reports are most useful with the distribution and version, desktop environment, X11 or Wayland session type, and steps to reproduce. The remaining platform limits are described above.

The **Licenses and acknowledgements** command opens the bundled notices inside Visual Studio Code.

## Contributing

Development setup, checks, and release procedures are documented in [DEVELOPMENT.md](https://github.com/s-a/Bitfroest.fs/blob/HEAD/DEVELOPMENT.md).
