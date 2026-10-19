# tools

Development helpers. Nothing here ships with the plugin.

## `asar.mjs`

A dependency-free, read-only ASAR reader. It is used to inspect the installed
DeepSeek Harness bundle when checking which plugin APIs, slots and services a
given desktop build actually exposes. Extracted sources are reference material
and stay in the untracked `.refs/` directory.

```powershell
node tools/asar.mjs list    <archive> <dirPath>
node tools/asar.mjs size    <archive> <filePath>
node tools/asar.mjs extract <archive> <filePath> <outFile>
```

The archive lives at `<Harness install directory>\resources\app.asar`; on a
default Windows install that is
`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`.
