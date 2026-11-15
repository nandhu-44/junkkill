// Built-in knowledge about what counts as junk.
//
// A target is a folder name (simple `*` / `?` globs allowed). `when` lists
// sibling files that must exist next to the folder for it to count, which keeps
// generic names like `target` or `build` from matching unrelated folders.
// `risky` marks folders that are usually regenerable but deserve a second look.

export const DEFAULTS = {
  minDirSize: '10MB',
  minFileSize: '100MB',
  scanFiles: true,
  sort: 'size',
  confirm: true,
  targets: [],
  exclude: []
};

const JS_PROJECT = ['package.json'];
const PY_PROJECT = ['pyproject.toml', 'setup.py', 'setup.cfg'];
const DOTNET_PROJECT = ['*.csproj', '*.fsproj', '*.vbproj', '*.sln'];

export const DEFAULT_TARGETS = [
  // JavaScript / TypeScript
  { name: 'node_modules', group: 'node' },
  { name: 'bower_components', group: 'node' },
  { name: '.next', group: 'node' },
  { name: '.nuxt', group: 'node' },
  { name: '.svelte-kit', group: 'node' },
  { name: '.angular', group: 'node' },
  { name: '.turbo', group: 'node' },
  { name: '.parcel-cache', group: 'node' },
  { name: '.nyc_output', group: 'node' },
  { name: 'coverage', group: 'test', when: [...JS_PROJECT, ...PY_PROJECT] },

  // Python
  { name: '.venv', group: 'python' },
  { name: 'venv', group: 'python' },
  { name: '__pycache__', group: 'python' },
  { name: '.pytest_cache', group: 'python' },
  { name: '.mypy_cache', group: 'python' },
  { name: '.ruff_cache', group: 'python' },
  { name: '.pytype', group: 'python' },
  { name: '.hypothesis', group: 'python' },
  { name: '.tox', group: 'python' },
  { name: '.nox', group: 'python' },
  { name: '.ipynb_checkpoints', group: 'jupyter' },
  { name: '*.egg-info', group: 'python' },

  // Compiled languages
  { name: 'target', group: 'rust', when: ['Cargo.toml'] },
  { name: 'target', group: 'maven', when: ['pom.xml'] },
  { name: 'build', group: 'gradle', when: ['build.gradle', 'build.gradle.kts'] },
  { name: '.gradle', group: 'gradle' },
  { name: 'bin', group: 'dotnet', when: DOTNET_PROJECT },
  { name: 'obj', group: 'dotnet', when: DOTNET_PROJECT },
  { name: 'cmake-build-*', group: 'cmake' },
  { name: 'CMakeFiles', group: 'cmake' },
  { name: '.zig-cache', group: 'zig' },
  { name: 'zig-cache', group: 'zig' },
  { name: 'zig-out', group: 'zig', when: ['build.zig'] },
  { name: '.stack-work', group: 'haskell' },
  { name: 'dist-newstyle', group: 'haskell' },
  { name: '_build', group: 'elixir', when: ['mix.exs'] },
  { name: 'deps', group: 'elixir', when: ['mix.exs'] },
  { name: 'elm-stuff', group: 'elm' },
  { name: '.dart_tool', group: 'dart' },

  // Mobile / platform
  { name: 'Pods', group: 'cocoapods', when: ['Podfile'] },
  { name: 'DerivedData', group: 'xcode' },

  // Infra
  { name: '.terraform', group: 'terraform' },
  { name: '.serverless', group: 'serverless' },

  // Generic build output: usually safe, but check first
  { name: 'dist', group: 'build', risky: true, when: [...JS_PROJECT, ...PY_PROJECT] },
  { name: 'build', group: 'build', risky: true, when: [...JS_PROJECT, ...PY_PROJECT, 'CMakeLists.txt'] },
  { name: 'vendor', group: 'php', risky: true, when: ['composer.json'] },

  // Caches
  { name: '.cache', group: 'cache' },
  { name: '.sass-cache', group: 'cache' }
];

// Folders never worth descending into.
export const DEFAULT_EXCLUDE = [
  '.git',
  '.svn',
  '.hg',
  '.Trash',
  '.Trashes',
  'System Volume Information',
  '$Recycle.Bin'
];

// Absolute paths that are skipped when scanning from `/`.
export const DEFAULT_EXCLUDE_PATHS = process.platform === 'win32'
  ? []
  : ['/proc', '/sys', '/dev', '/run', '/snap', '/System/Volumes'];

const FILE_KINDS = {
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz4'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'],
  image: ['psd', 'tif', 'tiff', 'raw', 'cr2', 'nef', 'exr'],
  disk: ['iso', 'img', 'dmg', 'vmdk', 'vdi', 'qcow2', 'vhd', 'vhdx', 'ova'],
  installer: ['exe', 'msi', 'deb', 'rpm', 'pkg', 'appimage', 'apk', 'ipa'],
  model: ['pt', 'pth', 'ckpt', 'safetensors', 'gguf', 'ggml', 'onnx', 'h5', 'tflite', 'mlmodel'],
  data: ['csv', 'tsv', 'parquet', 'jsonl', 'ndjson', 'npy', 'npz', 'feather', 'arrow', 'sqlite', 'db', 'sql'],
  log: ['log'],
  dump: ['dmp', 'core', 'hprof', 'heapsnapshot']
};

const KIND_BY_EXT = new Map(
  Object.entries(FILE_KINDS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind]))
);

export function fileKind(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'file';
  return KIND_BY_EXT.get(name.slice(dot + 1).toLowerCase()) ?? 'file';
}
