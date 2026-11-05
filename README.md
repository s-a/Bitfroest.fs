# Bitfroest.fs

[![Marketplace version](https://vsmarketplacebadges.dev/version/bitfroest.bitfroest-fs-prototype.svg)](https://marketplace.visualstudio.com/items?itemName=bitfroest.bitfroest-fs-prototype)
[![Marketplace downloads](https://vsmarketplacebadges.dev/downloads/bitfroest.bitfroest-fs-prototype.svg)](https://marketplace.visualstudio.com/items?itemName=bitfroest.bitfroest-fs-prototype)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs/bitfroest.bitfroest-fs-prototype.svg)](https://marketplace.visualstudio.com/items?itemName=bitfroest.bitfroest-fs-prototype)
[![Build: main](https://github.com/s-a/Bitfroest.fs/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/s-a/Bitfroest.fs/actions/workflows/release.yml?query=branch%3Amain)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**A two-panel file manager for Visual Studio Code.** File operations, folder tabs and Git views share a compact editor window.

![Bitfroest.fs with two folders, native Windows icons and file colors](media/marketplace/showcases/0001-windows-en-dark-main-overview.png)

**Beta version** — This extension is under development and may contain bugs or incomplete features.

## Get started

Requires Visual Studio Code 1.100.0 or later within the declared compatible version range. Install the pre-release package for a supported operating system and processor. The Command Palette entry **Bitfroest.fs: Show/hide file manager** or its folder button in the Status Bar opens the file manager.

The default shortcut is `Ctrl+Alt+Shift+F12` on Windows and Linux. Repeating the command closes the window. Each panel has its own folder tabs and navigation history. Keyboard shortcuts can be customized in VS Code.

<!-- showcase-gallery:start -->
## Feature walkthrough

Windows examples with sample project files. Animations include a pointer highlight and keystroke hints. Drag-and-drop demonstrations stop at the confirmation dialog.

<details>
<summary>Copy a folder path</summary>

<p><small>Copy the current folder path from the address bar.</small></p>

Right-click the address bar and observe the actual clipboard confirmation.

![Copy a folder path](media/marketplace/showcases/0002-windows-en-dark-path-copy-gesture.gif)

</details>

<details>
<summary>Select files with the right mouse button</summary>

<p><small>Select several files with a right-button drag.</small></p>

Draw a selection with the right mouse button held down.

![Select files with the right mouse button](media/marketplace/showcases/0003-windows-en-dark-right-selection-gesture.gif)

</details>

<details>
<summary>Drag a selection with the right button held</summary>

<p><small>Drag selected files and review the destination before moving them.</small></p>

Hold the right mouse button and drag selected files to a destination folder; review the move confirmation.

![Drag a selection with the right button held](media/marketplace/showcases/0004-windows-en-dark-right-drag-gesture.gif)

</details>

<details>
<summary>Focus the address bar with Ctrl+L</summary>

<p><small>Jump to the folder path with Ctrl+L.</small></p>

Press Ctrl+L and edit the selected path in the active address bar.

![Focus the address bar with Ctrl+L](media/marketplace/showcases/0005-windows-en-dark-shortcut-ctrl-l-gesture.gif)

</details>

<details>
<summary>Commands organized by task</summary>

<p><small>Find commands grouped by task.</small></p>

Discover file actions, selection tools, navigation, view options, configuration and help.

![Commands organized by task](media/marketplace/showcases/0006-windows-en-dark-main-menus-files.png)

![Commands organized by task](media/marketplace/showcases/0007-windows-en-dark-main-menus-selection.png)

![Commands organized by task](media/marketplace/showcases/0008-windows-en-dark-main-menus-commands.png)

![Commands organized by task](media/marketplace/showcases/0009-windows-en-dark-main-menus-view.png)

![Commands organized by task](media/marketplace/showcases/0010-windows-en-dark-main-menus-configuration.png)

![Commands organized by task](media/marketplace/showcases/0011-windows-en-dark-main-menus-help.png)

</details>

<details>
<summary>Choose a favorite location</summary>

<p><small>Open saved project folders from the favorites menu.</small></p>

Browse favorite project folders from the location menu.

![Favorite locations containing only sample project folders](media/marketplace/showcases/0012-windows-en-dark-location-menu-favorites.png)

</details>

<details>
<summary>Select files by pattern</summary>

<p><small>Select filenames with masks or regular expressions.</small></p>

Enter file masks or regular expressions without applying a selection.

![Select files by pattern](media/marketplace/showcases/0013-windows-en-dark-select-group-dialog.png)

</details>

<details>
<summary>Remove a group from the selection</summary>

<p><small>Remove matching filenames from the current selection.</small></p>

Specify the file pattern to remove from the current selection.

![Remove a group from the selection](media/marketplace/showcases/0014-windows-en-dark-unselect-group-dialog.png)

</details>

<details>
<summary>Create a folder</summary>

Inspect the folder name and destination before creating anything.

![Create a folder](media/marketplace/showcases/0015-windows-en-dark-new-folder-dialog.png)

</details>

<details>
<summary>Create a text file</summary>

Inspect the new text-file dialog without creating a file.

![Create a text file](media/marketplace/showcases/0016-windows-en-dark-new-file-dialog.png)

</details>

<details>
<summary>Copy files</summary>

Review the destination, overwrite policy and verification options before copying.

![Copy files](media/marketplace/showcases/0017-windows-en-dark-copy-dialog.png)

</details>

<details>
<summary>Move files</summary>

Review the destination and transfer options before moving files.

![Move files](media/marketplace/showcases/0018-windows-en-dark-move-dialog.png)

</details>

<details>
<summary>Rename a single entry</summary>

<p><small>Edit a filename directly in the file list.</small></p>

Open inline rename with a delayed second click, cancel it, then use F2 and cancel again without changing the file.

![Rename a single entry](media/marketplace/showcases/0019-windows-en-dark-rename-inline-editor.gif)

[Watch WebM](media/marketplace/showcases/0019-windows-en-dark-rename-inline-editor.webm)

</details>

<details>
<summary>Preview multiple filenames</summary>

<p><small>Preview generated names before applying a batch rename.</small></p>

Inspect naming masks, counters and replacement rules before applying changes.

![Preview multiple filenames](media/marketplace/showcases/0020-windows-en-dark-rename-multiple-dialog.png)

</details>

<details>
<summary>Review a recycle-bin deletion</summary>

<p><small>Review what will move to the recycle bin.</small></p>

Inspect the confirmation for moving selected entries to the recycle bin.

![Review a recycle-bin deletion](media/marketplace/showcases/0021-windows-en-dark-delete-trash-confirmation.png)

</details>

<details>
<summary>Review permanent deletion</summary>

<p><small>Review permanent deletion before confirming.</small></p>

Inspect the permanent-deletion warning without confirming it.

![Review permanent deletion](media/marketplace/showcases/0022-windows-en-dark-delete-permanently-confirmation.png)

</details>

<details>
<summary>Find files</summary>

<p><small>Search by filename, contents, or saved presets.</small></p>

Inspect basic criteria, advanced filters and saved searches before starting a search.

![Find files](media/marketplace/showcases/0023-windows-en-dark-file-search-general.png)

![Find files](media/marketplace/showcases/0024-windows-en-dark-file-search-advanced.png)

![Find files](media/marketplace/showcases/0025-windows-en-dark-file-search-presets.png)

</details>

<details>
<summary>Keep a search window open</summary>

<p><small>Keep search open beside the file manager.</small></p>

Open the nonmodal search variant alongside the file manager.

![Keep a search window open](media/marketplace/showcases/0026-windows-en-dark-file-search-separate-dialog.png)

</details>

<details>
<summary>Inspect file contents</summary>

<p><small>Read text, inspect binary data, and switch encodings.</small></p>

View a real file in text, binary, hexadecimal, HTML-text, Unicode and UTF-8 modes.

![Inspect file contents](media/marketplace/showcases/0027-windows-en-dark-file-viewer-text.png)

![Inspect file contents](media/marketplace/showcases/0028-windows-en-dark-file-viewer-binary.png)

![Inspect file contents](media/marketplace/showcases/0029-windows-en-dark-file-viewer-hex.png)

![Inspect file contents](media/marketplace/showcases/0030-windows-en-dark-file-viewer-html.png)

![Inspect file contents](media/marketplace/showcases/0031-windows-en-dark-file-viewer-unicode.png)

![Inspect file contents](media/marketplace/showcases/0032-windows-en-dark-file-viewer-utf8.png)

![Inspect file contents](media/marketplace/showcases/0033-windows-en-dark-file-viewer-edit-menu.png)

![Inspect file contents](media/marketplace/showcases/0034-windows-en-dark-file-viewer-options-menu.png)

![Inspect file contents](media/marketplace/showcases/0035-windows-en-dark-file-viewer-encoding-menu.png)

</details>

<details>
<summary>Search inside the viewer</summary>

<p><small>Find matching text in the current file.</small></p>

Inspect text-search, direction and matching options.

![Search inside the viewer](media/marketplace/showcases/0036-windows-en-dark-viewer-search-dialog.png)

</details>

<details>
<summary>Choose another codepage</summary>

<p><small>Choose an encoding for the current file.</small></p>

Inspect the codepage input without saving an encoding preference.

![Choose another codepage](media/marketplace/showcases/0037-windows-en-dark-viewer-codepage-dialog.png)

</details>

<details>
<summary>Prepare a ZIP archive</summary>

<p><small>Prepare a ZIP archive with selected files.</small></p>

Inspect compression, encryption and recursive packing options without creating an archive.

![Prepare a ZIP archive](media/marketplace/showcases/0038-windows-en-dark-archive-pack-dialog.png)

</details>

<details>
<summary>Prepare ZIP extraction</summary>

<p><small>Choose extraction options before writing files.</small></p>

Inspect destination and extraction options without writing files.

![Prepare ZIP extraction](media/marketplace/showcases/0039-windows-en-dark-archive-unpack-dialog.png)

</details>

<details>
<summary>Inspect local Git changes</summary>

<p><small>Review changed files in the sample repository.</small></p>

Show modified, staged and untracked entries in the demonstration repository.

![Inspect local Git changes](media/marketplace/showcases/0040-windows-en-dark-git-status-overview.png)

</details>

<details>
<summary>Browse commit history</summary>

<p><small>Browse commits and their changed files.</small></p>

Inspect the commit graph, commit message and changed files.

![Browse commit history](media/marketplace/showcases/0041-windows-en-dark-git-history-log.png)

</details>

<details>
<summary>Compare committed or working versions</summary>

<p><small>Compare a file with its committed version.</small></p>

Open the actual VS Code diff editor for a selected Git file.

![Compare committed or working versions](media/marketplace/showcases/0042-windows-en-dark-git-diff-working-tree.png)

</details>

<details>
<summary>Inspect available local branches</summary>

<p><small>Browse local branches without switching.</small></p>

Open the read-only branch list for the active repository.

![Native Visual Studio Code list of branches from the sample repository](media/marketplace/showcases/0043-windows-en-dark-git-branches-quickpick.png)

</details>

<details>
<summary>Configure the file manager</summary>

<p><small>Configure the file manager in VS Code settings.</small></p>

Inspect the native integration entry and extension configuration categories.

![Configure the file manager](media/marketplace/showcases/0044-windows-en-dark-settings-editor.png)

</details>

<details>
<summary>Configure favorite locations</summary>

<p><small>Configure saved folders and groups.</small></p>

Manage favorite locations and groups.

![Configure favorite locations](media/marketplace/showcases/0045-windows-en-dark-settings-favorites-editor.png)

</details>

<details>
<summary>Configure file-list columns</summary>

<p><small>Choose file-list columns and visible fields.</small></p>

Inspect column sets, field choices and column visibility.

![Configure file-list columns](media/marketplace/showcases/0046-windows-en-dark-settings-columns-editor.png)

</details>

<details>
<summary>Configure keyboard shortcuts</summary>

<p><small>Set key bindings for file manager commands.</small></p>

Inspect commands, editable bindings and conflict information.

![Configure keyboard shortcuts](media/marketplace/showcases/0047-windows-en-dark-settings-shortcuts-editor.png)

</details>

<details>
<summary>Inspect references to a folder</summary>

<p><small>See which processes reference files in a folder.</small></p>

A preview build keeps Build.log open and loads Preview-Plugin.dll. Inspect its real process references and the scan's access limits without releasing locks.

![Inspect references to a folder](media/marketplace/showcases/0048-windows-en-dark-folder-locks-processes.png)

</details>

<details>
<summary>Choose a folder-lock action</summary>

<p><small>Review actions for detected folder locks.</small></p>

Inspect available process and folder actions for a real scan result.

![Choose a folder-lock action](media/marketplace/showcases/0049-windows-en-dark-folder-lock-actions-quickpick.png)

</details>

<details>
<summary>Choose a destination for a locked folder</summary>

<p><small>Check a destination before copying a locked folder.</small></p>

Review the complete destination path for a folder copy. The example leaves the input unconfirmed.

![Choose a destination for a locked folder](media/marketplace/showcases/0050-windows-en-dark-folder-lock-target-destination.png)

</details>

<details>
<summary>Review a lock-management operation</summary>

<p><small>Review the warning before closing handles or unloading modules.</small></p>

Review the warning before closing file handles or unloading modules. The example stops before Run.

![Review a lock-management operation](media/marketplace/showcases/0051-windows-en-dark-folder-lock-confirmation-warning.png)

</details>

<details>
<summary>X-Ray on click</summary>

<p><small>Preview the selected file in the opposite pane.</small></p>

Inspect a text file in the opposite pane with syntax highlighting and a complete minimap. The preview uses 60% of the available width. Select files by clicking or using the keyboard. Right-click the eye to turn X-Ray off.

![X-Ray on click](media/marketplace/showcases/0052-windows-en-dark-xray-click-preview.png)

</details>

<details>
<summary>X-Ray Ultra</summary>

<p><small>Preview files after pausing on them.</small></p>

X-Ray Ultra updates the opposite preview after pausing over a text file for 200 ms. Syntax highlighting and a complete minimap use 60% of the available width; the source list shows filenames and icons. Right-click the eye to turn X-Ray off.

![X-Ray Ultra](media/marketplace/showcases/0053-windows-en-dark-xray-hover-preview.png)

</details>

<details>
<summary>Quick Diff: current folder</summary>

<p><small>Compare changed files with HEAD in the current folder.</small></p>

Select a changed file to compare its saved content with HEAD in a read-only inline diff. Unchanged sections are collapsed with three context lines and can be expanded. The title shows separate added, changed and deleted line counts. Both modes show paths relative to the repository root with native separators. Full-width filenames appear above a compact status · relative time · root-relative directory line. Filenames use the normal theme foreground without file icons; only status labels use Git colors. Time, separators and paths use the readable theme foreground. Name, status and date remain sortable, with status then newest first as the default order. Exact-date tooltips show the local modification time. Filename and directory tooltips show the complete file path; Ctrl+Y copies it, and Ctrl+Shift+Y copies it with forward slashes. Double-click a file to leave Quick Diff and select it in its folder. History Back restores the previous Quick Diff scope, file selection, sort and scroll position. Ignored files are excluded. Double-click the preview to open the full VS Code diff editor.

![Quick Diff: current folder](media/marketplace/showcases/0054-windows-en-dark-quick-diff-folder-preview.png)

</details>

<details>
<summary>Quick Diff: entire repository</summary>

<p><small>Review changes across the full repository.</small></p>

Cycle the footer button to include the entire repository, including new files and excluding ignored files. Root-level files omit the redundant directory marker. New files appear as syntax-highlighted additions against an empty original; deleted files show the HEAD content as removed lines.

![Quick Diff: entire repository](media/marketplace/showcases/0055-windows-en-dark-quick-diff-repository-preview.png)

</details>

<!-- showcase-gallery:end -->

## Configuration

The **Configuration** menu opens settings for file operations, favorites, columns and shortcuts. Additional options are available by searching for `Bitfroest` in VS Code Settings. Tab layouts can be stored per workspace or shared across workspaces.

## Platform support

| Platform | Support |
| --- | --- |
| Windows | Primary supported platform, including native Windows integrations |
| Linux | Native file copy, symbolic links, Git index actions, supported desktop capabilities and portable file operations. File clipboard access uses X11, supported Wayland data-control protocols or an existing XWayland connection. The Windows shell context menu is unavailable |
| macOS | Not supported |

Published Windows and Linux packages target x64 processors. Linux packages target Ubuntu 24.04 or a compatible newer runtime.

Native folder icons on Linux require GIO, GdkPixbuf and installed image loaders. SVG icons require the librsvg loader. On Ubuntu, these runtime components are provided by `libglib2.0-0t64`, `libgdk-pixbuf-2.0-0`, `librsvg2-common` and `shared-mime-info`.

Linux copies preserve symbolic links as links, including relative and dangling targets. Explicitly opening a directory link navigates to its canonical target within the permitted roots. Recursive copy and deletion do not traverse link targets. Copy publication does not require hardlinks. Native copying preserves file and directory permissions, ownership, timestamps, extended attributes and POSIX ACLs when the filesystem and current permissions allow them; metadata failures are reported. Sparse files retain holes where the filesystem exposes data and hole ranges. Symbolic-link extended attributes require an API that can address the held link identity; copying a link carrying such attributes currently reports an unsupported-metadata error.

Linux file clipboard access uses the current extension host's desktop session. It requires `libxcb.so.1` with `libxcb-xfixes.so.0`, or `libwayland-client.so.0` with permission to use `ext-data-control-v1` or `wlr-data-control`. Wayland sessions without these protocols can use an already running XWayland server identified through its public extension; the extension does not start XWayland. Private integration tests cover Mutter 46.2 through XWayland and KWin 5.27 through data control. A named Wayland display is required; an inherited `WAYLAND_SOCKET` connection is not shared between native sessions. Sessions exposing neither permitted data control nor XWayland cannot provide system file clipboard access. Internal copy and paste remain available.

A completed move is confirmed by the file-operation backend. Partial completion updates the payload served by the owned clipboard source; clients that have already cached its contents receive no guaranteed refresh notification. Another application consuming a cut selection does not provide a standardized move-completion notification. Clipboard contents published by the extension remain available while their native session is active.

When an operating system function is unavailable, the file manager reports it in its lower status bar when that function is used. VS Code remote hosts, browser use and processor architectures beyond the published packages are not covered by a general compatibility claim.

## Beta notice

**Use at your own risk.** The software is provided as is, without warranties, to the extent permitted by applicable law. Warranty and liability are governed by the Apache License 2.0, in particular Sections 7 and 8. Mandatory statutory rights remain unaffected.

**Risk of data loss.** File operations modify real data and may cause unintended data loss. Use copies or test data when evaluating this beta. Where possible, work in a Git repository as an additional safety net, with important changes committed before file operations. Git does not protect untracked or ignored files and does not replace a backup. Only use production data if a current backup that can be restored is available. If there is any doubt about the backup, do not use this extension on production data.

## License and support

Licensed under the [Apache License 2.0](LICENSE). Project attribution is recorded in [NOTICE](NOTICE); third-party component licenses are included under `licenses`. Use the [GitHub issue tracker](https://github.com/s-a/Bitfroest.fs/issues) for project support and bug reports.

Community testing, contributions and feedback are welcome and appreciated. Linux bug reports are most useful with the distribution and version, desktop environment, X11 or Wayland session type, and steps to reproduce. The remaining platform limits are described above.

The **Licenses and acknowledgements** command opens the bundled notices inside Visual Studio Code.

## Contributing

Development setup, checks, and release procedures are documented in [DEVELOPMENT.md](https://github.com/s-a/Bitfroest.fs/blob/HEAD/DEVELOPMENT.md).
