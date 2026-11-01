import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

interface GraphNode {
  id: string;
  label: string;
  kind: 'file' | 'module';
  file?: string;
  line?: number;
}

interface GraphEdge {
  source: string;
  target: string;
  kind: 'use' | 'mod';
}

interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface ParsedItem {
  name: string;
  line: number;
}

interface ParsedFile {
  rel: string;
  mods: ParsedItem[];
  uses: ParsedItem[];
}

interface CrateInfo {
  name: string;
  normalizedName: string;
  dir: string;
  cargoTomlRel: string;
  rootFileRel?: string;
}

let panel: vscode.WebviewPanel | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let lastGraph: Graph | undefined;
let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Rust Use Graph');
  context.subscriptions.push(output);

  const showCommand = vscode.commands.registerCommand('rustUseGraph.show', async () => {
    if (panel) {
      panel.reveal();
      return;
    }

    panel = vscode.window.createWebviewPanel(
      'rustUseGraph',
      'Rust Use Graph',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = getWebviewHtml(panel.webview);

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        await refreshGraph();
      } else if (message?.type === 'openNode') {
        await openNodeLocation(String(message.nodeId));
      }
    });

    panel.onDidDispose(() => {
      panel = undefined;
      lastGraph = undefined;
    });

    await refreshGraph();
  });

  const onSave = vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (!panel) {
      return;
    }
    const fileName = document.fileName;
    if (!fileName.endsWith('.rs') && !fileName.endsWith('Cargo.toml')) {
      return;
    }

    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    refreshTimer = setTimeout(() => {
      void refreshGraph();
    }, 300);
  });

  context.subscriptions.push(showCommand, onSave);
}

export function deactivate(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
}

function log(message: string): void {
  if (output) {
    output.appendLine(message);
  }
}

async function refreshGraph(): Promise<void> {
  if (!panel) {
    return;
  }

  const startedAt = Date.now();
  try {
    const graph = await buildGraph();
    lastGraph = graph;
    log(`[graph] nodes=${graph.nodes.length}, edges=${graph.edges.length}, ${Date.now() - startedAt} ms`);
    panel.webview.postMessage({ type: 'graph', graph });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    log(`[error] ${message}`);
    if (error?.stack) {
      log(error.stack);
    }
    output?.show(true);
    vscode.window.showErrorMessage('Failed to build graph: ' + message);
  }
}

async function openNodeLocation(nodeId: string): Promise<void> {
  if (!lastGraph) {
    return;
  }

  const node = lastGraph.nodes.find((n) => n.id === nodeId);
  if (!node) {
    return;
  }

  if (!node.file) {
    vscode.window.showInformationMessage(
      `No known location for node "${node.label}".`
    );
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const absPath = path.join(workspaceFolder.uri.fsPath, node.file);
  if (!fs.existsSync(absPath)) {
    vscode.window.showWarningMessage(`File not found: ${node.file}`);
    return;
  }

  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    const line = Math.max(0, (node.line ?? 1) - 1);
    const position = new vscode.Position(line, 0);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      selection: new vscode.Range(position, position)
    });
  } catch (error: any) {
    vscode.window.showErrorMessage(
      'Failed to open file: ' + (error?.message ?? String(error))
    );
  }
}

async function findFilesSafe(include: string, exclude: string): Promise<vscode.Uri[]> {
  try {
    return await vscode.workspace.findFiles(include, exclude);
  } catch (e: any) {
    throw new Error(`findFiles(${include}): ${e?.message ?? String(e)}`);
  }
}

async function collectWorkspaceFiles(
  root: string
): Promise<{ rustFiles: vscode.Uri[]; cargoTomls: vscode.Uri[] }> {
  const all = await findFilesSafe('**/*.{rs,toml}', '**/target/**');
  const rustFiles: vscode.Uri[] = [];
  const cargoTomls: vscode.Uri[] = [];
  for (const uri of all) {
    if (uri.fsPath.endsWith('.rs')) {
      rustFiles.push(uri);
    } else if (uri.fsPath.endsWith('Cargo.toml')) {
      cargoTomls.push(uri);
    }
  }
  log(`[files] .rs=${rustFiles.length}, Cargo.toml=${cargoTomls.length}, root=${root}`);
  return { rustFiles, cargoTomls };
}

async function findCrates(root: string, cargoTomls: vscode.Uri[]): Promise<CrateInfo[]> {
  const crates: CrateInfo[] = [];
  for (const uri of cargoTomls) {
    let content: string;
    try {
      content = await fs.promises.readFile(uri.fsPath, 'utf8');
    } catch (e: any) {
      log(`[cargo] failed to read ${uri.fsPath}: ${e?.message ?? String(e)}`);
      continue;
    }

    const name = parsePackageName(content);
    if (!name) {
      continue;
    }

    const rel = path.relative(root, uri.fsPath).replace(/\\/g, '/');
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';

    const candidates = [
      path.posix.join(dir, 'src/lib.rs'),
      path.posix.join(dir, 'src/main.rs')
    ];

    const rootFileRel = candidates.find((p) => fs.existsSync(path.join(root, p)));

    crates.push({
      name,
      normalizedName: name.replace(/-/g, '_'),
      dir,
      cargoTomlRel: rel,
      rootFileRel
    });
  }
  log(`[crates] found: ${crates.length}`);
  return crates;
}

function parsePackageName(toml: string): string | undefined {
  let inPackage = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('[')) {
      inPackage = line === '[package]';
      continue;
    }

    if (!inPackage) {
      continue;
    }

    const m = line.match(/^name\s*=\s*(["'])(.+?)\1/);
    if (m) {
      return m[2];
    }
  }
  return undefined;
}

async function buildGraph(): Promise<Graph> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error('Workspace is not open.');
  }

  const root = workspaceFolder.uri.fsPath;
  log(`[build] start, root=${root}`);

  const { rustFiles, cargoTomls } = await collectWorkspaceFiles(root);
  const crates = await findCrates(root, cargoTomls);

  const crateNames = new Set<string>();
  const crateBySeg = new Map<string, CrateInfo>();
  for (const c of crates) {
    crateNames.add(c.name);
    crateNames.add(c.normalizedName);
    crateBySeg.set(c.name, c);
    crateBySeg.set(c.normalizedName, c);
  }

  const parsedFiles: ParsedFile[] = [];

  for (const uri of rustFiles) {
    const rel = path.relative(root, uri.fsPath).replace(/\\/g, '/');
    let raw: string;
    try {
      raw = await fs.promises.readFile(uri.fsPath, 'utf8');
    } catch (e: any) {
      log(`[read] ${rel}: ${e?.message ?? String(e)}`);
      continue;
    }
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = parseRustFileSafe(text, rel);
    parsedFiles.push({ rel, mods: parsed.mods, uses: parsed.uses });
  }

  const localNames = new Set<string>();
  for (const file of parsedFiles) {
    localNames.add(path.basename(file.rel, '.rs'));
    for (const mod of file.mods) {
      localNames.add(mod.name);
    }
  }

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const addNode = (node: GraphNode): void => {
    if (!nodes.has(node.id)) {
      nodes.set(node.id, node);
    }
  };

  const addEdge = (source: string, target: string, kind: 'use' | 'mod'): void => {
    edges.push({ source, target, kind });
  };

  // Pass 1: files and mod declarations (they take priority for source location).
  for (const file of parsedFiles) {
    const fileId = 'file:' + file.rel;
    addNode({ id: fileId, label: file.rel, kind: 'file', file: file.rel, line: 1 });

    for (const mod of file.mods) {
      const modId = 'mod:' + mod.name;
      addNode({
        id: modId,
        label: mod.name,
        kind: 'module',
        file: file.rel,
        line: mod.line
      });
      addEdge(fileId, modId, 'mod');
    }
  }

  // Pass 2: use declarations.
  for (const file of parsedFiles) {
    const fileId = 'file:' + file.rel;

    for (const use of file.uses) {
      if (!isInternalUse(use.name, localNames, crateNames)) {
        continue;
      }

      const modId = 'mod:' + use.name;
      const firstSeg = use.name.split('::')[0];
      const crateMatch = crateBySeg.get(firstSeg);

      if (crateMatch && crateMatch.rootFileRel) {
        addNode({
          id: modId,
          label: use.name,
          kind: 'module',
          file: crateMatch.rootFileRel,
          line: 1
        });
      } else {
        addNode({
          id: modId,
          label: use.name,
          kind: 'module',
          file: file.rel,
          line: use.line
        });
      }
      addEdge(fileId, modId, 'use');
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges
  };
}

function isInternalUse(
  usePath: string,
  localNames: Set<string>,
  crateNames: Set<string>
): boolean {
  const first = usePath.split('::')[0];
  if (first === 'crate' || first === 'self' || first === 'super') {
    return true;
  }
  if (crateNames.has(first)) {
    return true;
  }
  return localNames.has(first);
}

// --- Lexical preprocessor ---

function stripCommentsAndStrings(text: string): string {
  const out: string[] = [];
  const n = text.length;
  let i = 0;

  const emitBlank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      out.push(text[k] === '\n' ? '\n' : ' ');
    }
  };

  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];

    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      emitBlank(i, j);
      i = j;
      continue;
    }

    if (c === '/' && c2 === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; }
        else if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      emitBlank(i, j);
      i = j;
      continue;
    }

    {
      const prev = i === 0 ? ' ' : text[i - 1];
      const prevOk = !/[A-Za-z0-9_]/.test(prev);
      let rStart = -1;
      if (prevOk && c === 'r') rStart = i + 1;
      else if (prevOk && c === 'b' && c2 === 'r') rStart = i + 2;
      else if (prevOk && c === 'c' && c2 === 'r') rStart = i + 2;

      if (rStart !== -1) {
        let j = rStart;
        let hashes = 0;
        while (j < n && text[j] === '#') { hashes++; j++; }
        if (text[j] === '"') {
          j++;
          const closing = '"' + '#'.repeat(hashes);
          const endIdx = text.indexOf(closing, j);
          const end = endIdx === -1 ? n : endIdx + closing.length;
          emitBlank(i, end);
          i = end;
          continue;
        }
      }
    }

    {
      const prev = i === 0 ? ' ' : text[i - 1];
      const prevOk = !/[A-Za-z0-9_]/.test(prev);
      let strContentStart = -1;
      if (c === '"') strContentStart = i + 1;
      else if (prevOk && c === 'b' && c2 === '"') strContentStart = i + 2;
      else if (prevOk && c === 'c' && c2 === '"') strContentStart = i + 2;

      if (strContentStart !== -1) {
        let j = strContentStart;
        while (j < n && text[j] !== '"') {
          if (text[j] === '\\') j++;
          j++;
        }
        j = Math.min(n, j + 1);
        emitBlank(i, j);
        i = j;
        continue;
      }
    }

    if (c === "'") {
      let j = i + 1;
      let ok = false;
      if (text[j] === '\\') {
        j += 2;
        if (text[j] === "'") { j++; ok = true; }
      } else if (j < n && text[j] !== "'" && text[j] !== '\n') {
        j++;
        if (text[j] === "'") { j++; ok = true; }
      }
      if (ok) {
        emitBlank(i, j);
        i = j;
        continue;
      }
    }

    out.push(c);
    i++;
  }

  return out.join('');
}

function makeLineAt(source: string): (index: number) => number {
  const newlines: number[] = [];
  for (let k = 0; k < source.length; k++) {
    if (source[k] === '\n') newlines.push(k);
  }
  return (index: number): number => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < index) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

function parseRustFileSafe(
  text: string,
  rel: string
): { mods: ParsedItem[]; uses: ParsedItem[] } {
  let cleaned: string;
  try {
    cleaned = stripCommentsAndStrings(text);
  } catch (e: any) {
    log(`[strip] ${rel}: ${e?.message ?? String(e)}`);
    return { mods: [], uses: [] };
  }

  const lineAt = makeLineAt(cleaned);
  const mods: ParsedItem[] = [];
  const uses: ParsedItem[] = [];

  {
    const re = /\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      mods.push({ name: m[1], line: lineAt(m.index) });
    }
  }

  {
    const re = /\buse\s+([^;]+);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      const declText = 'use ' + m[1] + ';';
      const line = lineAt(m.index);
      for (const item of parseUseDeclaration(declText, line)) {
        uses.push(item);
      }
    }
  }

  return { mods, uses };
}

function parseUseDeclaration(text: string, line: number): ParsedItem[] {
  let source = text.trim();
  source = source.replace(/^pub\s+(\([^)]*\)\s*)?/, '');
  source = source.replace(/^use\s+/, '');
  source = source.replace(/;\s*$/, '');
  source = source.replace(/\s+as\s+[A-Za-z_]\w*/g, '');
  source = source.trim();

  const result: ParsedItem[] = [];

  const expand = (prefix: string, part: string): void => {
    part = part.trim();
    if (!part) {
      return;
    }

    const openIndex = part.indexOf('{');
    if (openIndex !== -1) {
      const closeIndex = findMatchingBrace(part, openIndex);
      if (closeIndex === -1) {
        return;
      }
      const before = part.slice(0, openIndex).replace(/::$/, '').trim();
      const inside = part.slice(openIndex + 1, closeIndex);
      const nextPrefix = joinPath(prefix, before);

      for (const item of splitTopLevel(inside, ',')) {
        expand(nextPrefix, item);
      }
      return;
    }

    const items = splitTopLevel(part, ',');
    if (items.length > 1) {
      for (const item of items) {
        expand(prefix, item);
      }
      return;
    }

    let current = part.trim();

    if (current === '*' || current.endsWith('::*')) {
      current = current.replace(/::\*$/, '').replace(/^\*$/, '');
      const target = current ? joinPath(prefix, current) : prefix;
      if (target) {
        result.push({ name: target, line });
      }
      return;
    }

    if (current === 'self') {
      if (prefix) {
        result.push({ name: prefix, line });
      }
      return;
    }

    if (current.startsWith('self::')) {
      current = current.slice('self::'.length);
    }

    if (current) {
      result.push({ name: joinPath(prefix, current), line });
    }
  };

  expand('', source);
  return result.filter((item) => Boolean(item.name));
}

function joinPath(prefix: string, part: string): string {
  if (!prefix) {
    return part;
  }
  if (!part) {
    return prefix;
  }
  return prefix + '::' + part;
}

function splitTopLevel(source: string, separator: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of source) {
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
    }

    if (char === separator && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    result.push(current);
  }

  return result;
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;

  for (let i = openIndex; i < source.length; i++) {
    const char = source[i];
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function getWebviewHtml(webview: vscode.Webview): string {
  const nonce = crypto.randomBytes(16).toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Rust Use Graph</title>
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: sans-serif;
    }
    #graph {
      width: 100%;
      height: 100%;
      display: block;
      cursor: grab;
      user-select: none;
      outline: none;
    }
    #graph.dragging { cursor: grabbing; }
    #graph.over-node { cursor: pointer; }
    #hint {
      position: absolute;
      left: 12px;
      bottom: 12px;
      font-size: 12px;
      opacity: 0.75;
      pointer-events: none;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <canvas id="graph" tabindex="0"></canvas>
  <div id="hint">
    Drag background — pan &middot; Wheel — zoom &middot; F — fit to view<br/>
    Drag node — move &middot; Double-click node — open location
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('graph');
    const ctx = canvas.getContext('2d');

    let graph = { nodes: [], edges: [] };
    let width = 1;
    let height = 1;
    const positions = new Map();
    const camera = { tx: 0, ty: 0, scale: 1 };
    let interaction = null;
    let hasFitted = false;

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'graph') {
        graph = message.graph;
        ensurePositions();
        if (!hasFitted && graph.nodes.length > 0) {
          hasFitted = true;
          setTimeout(fitToView, 800);
        }
      }
    });

    window.addEventListener('resize', resize);
    resize();
    vscode.postMessage({ type: 'ready' });

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function ensurePositions() {
      const spread = Math.max(300, Math.sqrt(graph.nodes.length || 1) * 120);
      for (const node of graph.nodes) {
        if (!positions.has(node.id)) {
          positions.set(node.id, {
            x: (Math.random() - 0.5) * spread,
            y: (Math.random() - 0.5) * spread,
            vx: 0,
            vy: 0,
            fixed: false
          });
        }
      }
    }

    function toCanvasCoords(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    }

    function screenToWorld(sx, sy) {
      return {
        x: (sx - camera.tx) / camera.scale,
        y: (sy - camera.ty) / camera.scale
      };
    }

    function findNodeAtScreen(sx, sy) {
      const world = screenToWorld(sx, sy);
      let best = null;
      let bestDist = Infinity;
      for (const node of graph.nodes) {
        const p = positions.get(node.id);
        if (!p) continue;
        const nodeRadius = node.kind === 'file' ? 7 : 5;
        const hitRadius = nodeRadius + 8 / camera.scale;
        const dx = p.x - world.x;
        const dy = p.y - world.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < hitRadius && dist < bestDist) {
          bestDist = dist;
          best = node;
        }
      }
      return best;
    }

    function fitToView() {
      if (graph.nodes.length === 0) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const node of graph.nodes) {
        const p = positions.get(node.id);
        if (!p) continue;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      if (!isFinite(minX) || !isFinite(maxX)) return;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const pad = 80;
      const w = Math.max(1, maxX - minX) + pad * 2;
      const h = Math.max(1, maxY - minY) + pad * 2;
      const scale = Math.min(width / w, height / h, 2);
      camera.scale = Math.max(0.05, Math.min(6, scale));
      camera.tx = width / 2 - cx * camera.scale;
      camera.ty = height / 2 - cy * camera.scale;
    }

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      canvas.focus();
      const c = toCanvasCoords(e.clientX, e.clientY);
      const node = findNodeAtScreen(c.x, c.y);
      const world = screenToWorld(c.x, c.y);

      if (node) {
        const p = positions.get(node.id);
        interaction = {
          type: 'drag-node',
          nodeId: node.id,
          offsetX: world.x - p.x,
          offsetY: world.y - p.y
        };
        p.fixed = true;
        p.vx = 0;
        p.vy = 0;
      } else {
        interaction = {
          type: 'pan',
          startX: e.clientX,
          startY: e.clientY,
          startTx: camera.tx,
          startTy: camera.ty
        };
      }

      canvas.classList.add('dragging');
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (interaction) {
        if (interaction.type === 'drag-node') {
          const c = toCanvasCoords(e.clientX, e.clientY);
          const world = screenToWorld(c.x, c.y);
          const p = positions.get(interaction.nodeId);
          if (p) {
            p.x = world.x - interaction.offsetX;
            p.y = world.y - interaction.offsetY;
            p.vx = 0;
            p.vy = 0;
          }
        } else if (interaction.type === 'pan') {
          camera.tx = interaction.startTx + (e.clientX - interaction.startX);
          camera.ty = interaction.startTy + (e.clientY - interaction.startY);
        }
        return;
      }

      const rect = canvas.getBoundingClientRect();
      if (
        e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top  || e.clientY > rect.bottom
      ) {
        canvas.classList.remove('over-node');
        return;
      }

      const c = toCanvasCoords(e.clientX, e.clientY);
      const node = findNodeAtScreen(c.x, c.y);
      if (node) {
        canvas.classList.add('over-node');
      } else {
        canvas.classList.remove('over-node');
      }
    });

    window.addEventListener('mouseup', () => {
      if (interaction && interaction.type === 'drag-node') {
        const p = positions.get(interaction.nodeId);
        if (p) {
          p.fixed = false;
        }
      }
      interaction = null;
      canvas.classList.remove('dragging');
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const c = toCanvasCoords(e.clientX, e.clientY);
      const worldBefore = screenToWorld(c.x, c.y);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const nextScale = Math.max(0.05, Math.min(6, camera.scale * factor));
      camera.scale = nextScale;
      camera.tx = c.x - worldBefore.x * camera.scale;
      camera.ty = c.y - worldBefore.y * camera.scale;
    }, { passive: false });

    canvas.addEventListener('dblclick', (e) => {
      const c = toCanvasCoords(e.clientX, e.clientY);
      const node = findNodeAtScreen(c.x, c.y);
      if (node) {
        vscode.postMessage({ type: 'openNode', nodeId: node.id });
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'f' || e.key === 'F') {
        fitToView();
      }
    });

    function tick() {
      ensurePositions();

      const nodes = graph.nodes;
      const edges = graph.edges;

      // Soft centroid attraction: no viewport bounds, infinite canvas.
      let cx = 0, cy = 0, count = 0;
      for (const node of nodes) {
        const p = positions.get(node.id);
        if (!p || p.fixed) continue;
        cx += p.x;
        cy += p.y;
        count++;
      }
      if (count > 0) {
        cx /= count;
        cy /= count;
        for (const node of nodes) {
          const p = positions.get(node.id);
          if (!p || p.fixed) continue;
          p.vx += (cx - p.x) * 0.00002;
          p.vy += (cy - p.y) * 0.00002;
        }
      }

      for (let i = 0; i < nodes.length; i++) {
        const a = positions.get(nodes[i].id);
        if (!a) continue;

        for (let j = i + 1; j < nodes.length; j++) {
          const b = positions.get(nodes[j].id);
          if (!b) continue;
          if (a.fixed && b.fixed) continue;

          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dist2 = dx * dx + dy * dy;

          if (dist2 < 1) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            dist2 = 1;
          }

          const force = 2500 / dist2;
          const dist = Math.sqrt(dist2);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          if (!a.fixed) { a.vx += fx; a.vy += fy; }
          if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
        }
      }

      for (const edge of edges) {
        const a = positions.get(edge.source);
        const b = positions.get(edge.target);
        if (!a || !b) continue;
        if (a.fixed && b.fixed) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const desired = edge.kind === 'mod' ? 90 : 130;
        const force = (dist - desired) * 0.012;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        if (!a.fixed) { a.vx += fx; a.vy += fy; }
        if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
      }

      for (const node of nodes) {
        const p = positions.get(node.id);
        if (!p || p.fixed) continue;
        p.vx *= 0.82;
        p.vy *= 0.82;
        p.x += p.vx;
        p.y += p.vy;
        // No clamping — the canvas is infinite.
      }

      draw();
      requestAnimationFrame(tick);
    }

    function draw() {
      const ratio = window.devicePixelRatio || 1;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);

      ctx.save();
      ctx.translate(camera.tx, camera.ty);
      ctx.scale(camera.scale, camera.scale);

      for (const edge of graph.edges) {
        const a = positions.get(edge.source);
        const b = positions.get(edge.target);
        if (!a || !b) continue;

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = edge.kind === 'mod'
          ? 'rgba(255, 165, 0, 0.55)'
          : 'rgba(160, 160, 160, 0.5)';
        ctx.lineWidth = 1.2 / camera.scale;
        ctx.setLineDash(edge.kind === 'mod' ? [5 / camera.scale, 4 / camera.scale] : []);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      const showLabels = camera.scale >= 0.6;

      for (const node of graph.nodes) {
        const p = positions.get(node.id);
        if (!p) continue;

        const r = (node.kind === 'file' ? 7 : 5) / Math.max(camera.scale, 0.5);

        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = node.kind === 'file' ? '#4da3ff' : '#ffb347';
        ctx.fill();

        if (showLabels) {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.scale(1 / camera.scale, 1 / camera.scale);
          ctx.font = '11px sans-serif';
          ctx.fillStyle = 'rgba(230, 230, 230, 0.92)';
          ctx.fillText(node.label, 10, 4);
          ctx.restore();
        }
      }

      ctx.restore();
    }

    requestAnimationFrame(tick);
  </script>
</body>
</html>`;
}