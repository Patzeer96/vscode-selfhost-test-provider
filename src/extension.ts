/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FailingDeepStrictEqualAssertFixer } from './failingDeepStrictEqualAssertFixer';
import { registerSnapshotUpdate } from './snapshot';
import { scanTestOutput } from './testOutputScanner';
import {
  clearFileDiagnostics,
  guessWorkspaceFolder,
  itemData,
  TestCase,
  TestFile,
} from './testTree';
import { BrowserTestRunner, PlatformTestRunner, VSCodeTestRunner } from './vscodeTestRunner';

const TEST_FILE_PATTERN = 'src/vs/**/*.{test,integrationTest}.ts';

const getWorkspaceFolderForTestFile = (uri: vscode.Uri) =>
  (uri.path.endsWith('.test.ts') || uri.path.endsWith('.integrationTest.ts')) &&
  uri.path.includes('/src/vs/')
    ? vscode.workspace.getWorkspaceFolder(uri)
    : undefined;

const browserArgs: [name: string, arg: string][] = [
  ['Chrome', 'chromium'],
  ['Firefox', 'firefox'],
  ['Webkit', 'webkit'],
];

type FileChangeEvent = { uri: vscode.Uri; removed: boolean };

export async function activate(context: vscode.ExtensionContext) {
  const ctrl = vscode.tests.createTestController('selfhost-test-controller', 'VS Code Tests');
  const fileChangedEmitter = new vscode.EventEmitter<FileChangeEvent>();

  ctrl.resolveHandler = async test => {
    if (!test) {
      context.subscriptions.push(await startWatchingWorkspace(ctrl, fileChangedEmitter));
      return;
    }

    const data = itemData.get(test);
    if (data instanceof TestFile) {
      // No need to watch this, updates will be triggered on file changes
      // either by the text document or file watcher.
      await data.updateFromDisk(ctrl, test);
    }
  };

  const createRunHandler = (
    runnerCtor: { new (folder: vscode.WorkspaceFolder): VSCodeTestRunner },
    kind: vscode.TestRunProfileKind,
    args: string[] = []
  ) => {
    const doTestRun = async (
      req: vscode.TestRunRequest,
      cancellationToken: vscode.CancellationToken
    ) => {
      const folder = await guessWorkspaceFolder();
      if (!folder) {
        return;
      }

      const runner = new runnerCtor(folder);
      const map = await getPendingTestMap(ctrl, req.include ?? gatherTestItems(ctrl.items));
      const task = ctrl.createTestRun(req);
      for (const test of map.values()) {
        task.enqueued(test);
      }

      let coverageDir: string | undefined;
      let currentArgs = args;
      if (kind === vscode.TestRunProfileKind.Coverage) {
        coverageDir = path.join(tmpdir(), `vscode-test-coverage-${randomBytes(8).toString('hex')}`);
        currentArgs = [
          ...currentArgs,
          '--coverage',
          '--coveragePath',
          coverageDir,
          '--coverageFormats',
          'json',
          '--coverageFormats',
          'html',
        ];
      }

      return await scanTestOutput(
        folder,
        map,
        task,
        kind === vscode.TestRunProfileKind.Debug
          ? await runner.debug(currentArgs, req.include)
          : await runner.run(currentArgs, req.include),
        coverageDir,
        cancellationToken
      );
    };

    return async (req: vscode.TestRunRequest, cancellationToken: vscode.CancellationToken) => {
      if (!req.continuous) {
        return doTestRun(req, cancellationToken);
      }

      const queuedFiles = new Set<string>();
      let debounced: NodeJS.Timer | undefined;

      const listener = fileChangedEmitter.event(({ uri, removed }) => {
        clearTimeout(debounced);

        if (req.include && !req.include.some(i => i.uri?.toString() === uri.toString())) {
          return;
        }

        if (removed) {
          queuedFiles.delete(uri.toString());
        } else {
          queuedFiles.add(uri.toString());
        }

        debounced = setTimeout(() => {
          const include =
            req.include?.filter(t => t.uri && queuedFiles.has(t.uri?.toString())) ??
            [...queuedFiles]
              .map(f => getOrCreateFile(ctrl, vscode.Uri.parse(f)))
              .filter((f): f is vscode.TestItem => !!f);
          queuedFiles.clear();

          doTestRun(
            new vscode.TestRunRequest(include, req.exclude, req.profile, true),
            cancellationToken
          );
        }, 1000);
      });

      cancellationToken.onCancellationRequested(() => {
        clearTimeout(debounced);
        listener.dispose();
      });
    };
  };

  ctrl.createRunProfile(
    'Run in Electron',
    vscode.TestRunProfileKind.Run,
    createRunHandler(PlatformTestRunner, vscode.TestRunProfileKind.Run),
    true,
    undefined,
    true
  );

  ctrl.createRunProfile(
    'Debug in Electron',
    vscode.TestRunProfileKind.Debug,
    createRunHandler(PlatformTestRunner, vscode.TestRunProfileKind.Debug),
    true,
    undefined,
    true
  );

  ctrl.createRunProfile(
    'Coverage in Electron',
    vscode.TestRunProfileKind.Coverage,
    createRunHandler(PlatformTestRunner, vscode.TestRunProfileKind.Coverage),
    true,
    undefined,
    true
  );

  for (const [name, arg] of browserArgs) {
    const cfg = ctrl.createRunProfile(
      `Run in ${name}`,
      vscode.TestRunProfileKind.Run,
      createRunHandler(BrowserTestRunner, vscode.TestRunProfileKind.Run, [' --browser', arg]),
      undefined,
      undefined,
      true
    );

    cfg.configureHandler = () => vscode.window.showInformationMessage(`Configuring ${name}`);

    ctrl.createRunProfile(
      `Debug in ${name}`,
      vscode.TestRunProfileKind.Debug,
      createRunHandler(BrowserTestRunner, vscode.TestRunProfileKind.Debug, [
        '--browser',
        arg,
        '--debug-browser',
      ]),
      undefined,
      undefined,
      true
    );
  }

  function updateNodeForDocument(e: vscode.TextDocument) {
    const node = getOrCreateFile(ctrl, e.uri);
    const data = node && itemData.get(node);
    if (data instanceof TestFile) {
      data.updateFromContents(ctrl, e.getText(), node!);
    }
  }

  for (const document of vscode.workspace.textDocuments) {
    updateNodeForDocument(document);
  }

  context.subscriptions.push(
    ctrl,
    fileChangedEmitter.event(({ uri, removed }) => {
      if (!removed) {
        const node = getOrCreateFile(ctrl, uri);
        if (node) {
          ctrl.invalidateTestResults();
        }
      }
    }),
    vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
    vscode.workspace.onDidChangeTextDocument(e => updateNodeForDocument(e.document)),
    registerSnapshotUpdate(ctrl),
    new FailingDeepStrictEqualAssertFixer()
  );
}

export function deactivate() {
  // no-op
}

function getOrCreateFile(
  controller: vscode.TestController,
  uri: vscode.Uri
): vscode.TestItem | undefined {
  const folder = getWorkspaceFolderForTestFile(uri);
  if (!folder) {
    return undefined;
  }

  const data = new TestFile(uri, folder);
  const existing = controller.items.get(data.getId());
  if (existing) {
    return existing;
  }

  const file = controller.createTestItem(data.getId(), data.getLabel(), uri);
  controller.items.add(file);
  file.canResolveChildren = true;
  itemData.set(file, data);

  return file;
}

function gatherTestItems(collection: vscode.TestItemCollection) {
  const items: vscode.TestItem[] = [];
  collection.forEach(item => items.push(item));
  return items;
}

async function startWatchingWorkspace(
  controller: vscode.TestController,
  fileChangedEmitter: vscode.EventEmitter<FileChangeEvent>
) {
  const workspaceFolder = await guessWorkspaceFolder();
  if (!workspaceFolder) {
    return new vscode.Disposable(() => undefined);
  }

  const pattern = new vscode.RelativePattern(workspaceFolder, TEST_FILE_PATTERN);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  watcher.onDidCreate(uri => {
    getOrCreateFile(controller, uri);
    fileChangedEmitter.fire({ removed: false, uri });
  });
  watcher.onDidChange(uri => fileChangedEmitter.fire({ removed: false, uri }));
  watcher.onDidDelete(uri => {
    fileChangedEmitter.fire({ removed: true, uri });
    clearFileDiagnostics(uri);
    controller.items.delete(uri.toString());
  });

  for (const file of await vscode.workspace.findFiles(pattern)) {
    getOrCreateFile(controller, file);
  }

  return watcher;
}

async function getPendingTestMap(ctrl: vscode.TestController, tests: Iterable<vscode.TestItem>) {
  const queue = [tests];
  const titleMap = new Map<string, vscode.TestItem>();
  while (queue.length) {
    for (const item of queue.pop()!) {
      const data = itemData.get(item);
      if (data instanceof TestFile) {
        if (!data.hasBeenRead) {
          await data.updateFromDisk(ctrl, item);
        }
        queue.push(gatherTestItems(item.children));
      } else if (data instanceof TestCase) {
        titleMap.set(data.fullName, item);
      } else {
        queue.push(gatherTestItems(item.children));
      }
    }
  }

  return titleMap;
}
