# junkkill

[![npm version](https://img.shields.io/npm/v/junkkill?style=flat-square&logo=npm)](https://www.npmjs.com/package/junkkill)
[![npm downloads](https://img.shields.io/npm/dm/junkkill?style=flat-square&logo=npm)](https://www.npmjs.com/package/junkkill)
[![node](https://img.shields.io/node/v/junkkill?style=flat-square&logo=node.js)](https://www.npmjs.com/package/junkkill)
[![license](https://img.shields.io/npm/l/junkkill?style=flat-square)](https://github.com/nandhu-44/junkkill/blob/main/LICENSE)

Find what's eating your disk and delete it from a fast, keyboard-driven list. It lists three kinds of things:

| Kind | What | Listed from |
| --- | --- | --- |
| **junk** | Regenerable folders: `node_modules`, virtualenvs, Rust/Maven/Gradle/.NET build output, caches… | 10 MB |
| **folder** | Any other folder holding lots of data, e.g. `Downloads/old-isos`. Marked `!` because it's your own data | 1 GB |
| **file** | Single big files, labelled by kind: video, archive, disk image, model weights, dataset, log, dump | 100 MB |

```
  junkkill  v0.2.0   ✓ 6,579 folders in 0.3s   list view
 ~/code                                junk ≥ 10 MB · folders ≥ 1 GB · files ≥ 100 MB
 reclaimable 4.21 GB    freed 0 B    found 7

    PATH                                     TYPE         MODIFIED     SIZE ▾
 ❯  photos/2023                              folder !      1y ago     1.80 GB
    media/movie.mp4                          video        2mo ago     1.50 GB
  ● webapp/node_modules                      node         3mo ago      812 MB
    api/.venv                                python        1y ago      402 MB
    tools/rusty/target                       rust          5d ago     30.0 MB

 1 selected · 812 MB   ↑↓ move  space select  enter delete  v tree  t kind  q quit
```

Press `v` (or start with `--tree`) for the **tree view**: a disk-analyzer style browser in the spirit of WizTree, SpaceSniffer or ncdu. It shows every folder with its size and share of the parent; open folders with `→`, go back with `←`, and delete from there too.

```
 ~/code/photos
 size 3.60 GB    freed 0 B    items 3

    NAME                          TYPE                    %        SIZE ▾
 ❯  2023/                         folder !   █████▏     51.2%     1.80 GB
    2024/                         folder !   ████▋      46.8%     1.64 GB
    412 smaller files                        ▏           2.0%     72.0 MB
```

- **Fast.** Scans on worker threads, one per core, using blocking filesystem calls. Results show up while the scan is still running.
- **Zero dependencies.** Plain Node.js 18+.
- **Knows the ecosystems.** Node, Python, Rust, Maven, Gradle, .NET, CMake, Zig, Haskell, Elixir, Dart, CocoaPods, Xcode, Terraform and more. Generic names such as `target`, `build` and `bin` only count when the matching project file is next to them (`Cargo.toml`, `build.gradle`, `*.csproj`, …).
- **No double counting.** A large folder is the deepest folder holding that much data that isn't already listed as junk or a large file, so you get `photos/2023` instead of `~`, `~/photos` and `~/photos/2023` for the same bytes. Deleting a folder marks everything listed inside it as gone.
- **Safe.** Only scanned items can be deleted, and each one is re-checked first: it must still exist, sit inside the scanned folder and not be a symlink. Items marked `!` get a warning in the confirmation prompt.

## Install

```bash
npm install -g junkkill
# or just run it
npx junkkill
```

## Usage

```bash
junkkill                      # scan the current folder
junkkill ~/code               # scan a specific folder
junkkill --tree ~             # browse your home folder by size
junkkill --min 500MB          # only list things of 500 MB or more
junkkill --min-folder 5GB     # raise the bar for regular folders only
junkkill --only junk          # just junk folders (fastest: skips file sizes)
junkkill --only folder,file   # just your own big stuff
junkkill -t node_modules      # look only for node_modules
junkkill --dry-run            # try it out without deleting anything
junkkill --list               # print a table and exit
junkkill --list --tree        # print sizes of the top-level folders
junkkill --json > junk.json   # machine-readable output
```

### Keys

| Key | Action |
| --- | --- |
| `↑` `↓` / `j` `k` | Move |
| `PgUp` `PgDn` `Home` `End` | Jump |
| `space` | Select or unselect |
| `a` | Select all visible items (press again to clear) |
| `d` / `Del` | Delete the selection, or the item under the cursor |
| `enter` | List view: delete. Tree view: open the folder |
| `→` / `←` | Tree view: open folder / go back up |
| `v` | Switch between list and tree view |
| `t` | List view: show everything, only junk, only folders or only files |
| `s` | Sort by size, age or name |
| `/` | Filter by name |
| `esc` | Clear the selection or filter, go up a folder, otherwise quit |
| `q` | Quit |

### Options

```text
--min <size>           Same size limit for all three kinds
--min-junk <size>      Smallest junk folder to list (default: 10MB)
--min-folder <size>    Smallest regular folder to list (default: 1GB)
--min-file <size>      Smallest file to list (default: 100MB)
--only <kinds>         List only these kinds, e.g. --only junk or --only folder,file
--tree                 Start in tree view: browse every folder by size
-d, --dir <path>       Folder to scan (default: current folder)
-t, --targets <list>   Only look for these junk folder names, comma separated
-e, --exclude <list>   Extra folder names to skip, comma separated
-s, --sort <key>       size | age | path (default: size)
--dry-run              Go through the motions without deleting anything
-y, --yes              Delete without asking for confirmation
--list                 Print results and exit (with --tree: print the top level)
--json                 Print results as JSON and exit
--config <file>        Use a different config file
--init                 Create the config file with default values
--no-color             Disable colors
```

Sizes accept `B`, `KB`, `MB`, `GB` and `TB` (for example `500KB` or `1.5GB`). A bare number means MB. The header always shows the limits in effect.

## Config

Settings live in `~/.config/junkkill/config.json` (`%APPDATA%\junkkill\config.json` on Windows; `$XDG_CONFIG_HOME` and `$JUNKKILL_CONFIG` are respected). The file is optional. Run `junkkill --init` to create one with the defaults:

```json
{
  "minJunkSize": "10MB",
  "minFolderSize": "1GB",
  "minFileSize": "100MB",
  "show": ["junk", "folder", "file"],
  "view": "list",
  "sort": "size",
  "confirm": true,
  "targets": [],
  "exclude": []
}
```

`show` picks the kinds listed by default, and `view` can be `list` or `tree`. Settings from 0.1 (`minDirSize`, `scanFiles`, `--min-dir`, `--no-files`) still work.

Command-line flags override the config file, and the config file overrides the defaults.

`targets` and `exclude` **add to** the built-in lists. Prefix a name with `!` to remove a built-in entry. Names can use `*` and `?` wildcards. A target can be a plain name or an object:

```json
{
  "targets": [
    "checkpoints",
    "*.egg-info",
    "!dist",
    { "name": "data", "when": ["*.ipynb"], "group": "dataset", "risky": true }
  ],
  "exclude": ["archive", "!.hg"]
}
```

| Target field | Meaning |
| --- | --- |
| `name` | Folder name, wildcards allowed |
| `when` | Only match if one of these files sits next to the folder |
| `group` | Label shown in the TYPE column |
| `risky` | Show the `!` marker and a warning when deleting |

Your targets are checked before the built-in ones, so an entry such as `{ "name": "build" }` replaces the built-in rule for `build`.

Optional extras: `threads` (number of scan workers, default: CPU cores, max 8).

## License

MIT
