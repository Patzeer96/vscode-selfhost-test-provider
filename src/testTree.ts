/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { relative } from 'path';
import * as ts from 'typescript';
import {
  CancellationToken,
  Location,
  Position,
  Progress,
  RelativePattern,
  TestItem,
  TextDocument,
  Uri,
  workspace,
  WorkspaceFolder,
} from 'vscode';
import { extractTestFromNode } from './sourceUtils';

declare const TextDecoder: typeof import('util').TextDecoder; // node in the typings yet

const locationEquals = (a: Location, b: Location) =>
  a.uri.toString() === b.uri.toString() && a.range.isEqual(b.range);

export const TEST_FILE_PATTERN = 'src/vs/**/*.test.ts';
export const idPrefix = 'ms-vscode.vscode-selfhost-test-provider/';

export const getContentsFromFile = async (file: Uri) => {
  const contents = await workspace.fs.readFile(file);
  return new TextDecoder('utf-8').decode(contents);
};

export abstract class TestRoot extends TestItem<TestFile> {
  public readonly runnable = true;
  public readonly debuggable = true;
  public readonly parent = undefined;

  public get root() {
    return this;
  }

  constructor(public readonly workspaceFolder: WorkspaceFolder) {
    super(idPrefix, 'VS Code Unit Tests', true);
  }
}

/**
 * The root node returned in `provideDocumentTestRoot`.
 */
export class DocumentTestRoot extends TestRoot {
  public get uri() {
    return this.document.uri;
  }

  constructor(workspaceFolder: WorkspaceFolder, private readonly document: TextDocument) {
    super(workspaceFolder);
  }

  public discoverChildren(progress: Progress<{ busy: boolean }>, token: CancellationToken) {
    const file = new TestFile(this.document.uri, this, () =>
      Promise.resolve(this.document.getText())
    );
    this.children.add(file);

    const changeListener = workspace.onDidChangeTextDocument(e => {
      if (e.document === this.document) {
        file.refresh();
      }
    });

    token.onCancellationRequested(() => changeListener.dispose());
    progress.report({ busy: false });
  }
}

/**
 * The root node returned in `provideWorkspaceTestRoot`.
 */
export class WorkspaceTestRoot extends TestRoot {
  /**
   * @override
   */
  public discoverChildren(progress: Progress<{ busy: boolean }>, token: CancellationToken) {
    const pattern = new RelativePattern(this.workspaceFolder, TEST_FILE_PATTERN);
    const watcher = workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(uri =>
      this.children.add(new TestFile(uri, this, () => getContentsFromFile(uri)))
    );
    watcher.onDidChange(uri => this.children.get(uri.toString())?.refresh());
    watcher.onDidDelete(uri => this.children.delete(uri.toString()));
    token.onCancellationRequested(() => watcher.dispose());

    workspace.findFiles(pattern).then(files => {
      for (const file of files) {
        this.children.add(new TestFile(file, this, () => getContentsFromFile(file)));
      }

      progress.report({ busy: false });
    });
  }
}

let generation = 0;

export class TestFile extends TestItem<TestSuite | TestCase> {
  public readonly runnable = true;
  public readonly debuggable = true;
  public readonly location = new Location(this.uri, new Position(0, 0));

  public get workspaceFolder() {
    return this.parent.workspaceFolder;
  }

  constructor(
    public readonly uri: Uri,
    public readonly parent: TestRoot,
    private readonly sourceReader: () => Promise<string>
  ) {
    super(uri.toString(), relative(parent.workspaceFolder.uri.fsPath, uri.fsPath), true);
  }

  /**
   * Refreshes all tests in this file, `sourceReader` provided by the root.
   */
  public async refresh() {
    try {
      const decoded = await this.sourceReader();
      const ast = ts.createSourceFile(
        this.uri.path.split('/').pop()!,
        decoded,
        ts.ScriptTarget.ESNext,
        false,
        ts.ScriptKind.TS
      );

      const parents: (TestFile | TestSuite)[] = [this];
      const thisGeneration = generation++;
      const traverse = (node: ts.Node) => {
        const parent = parents[parents.length - 1];
        const newItem = extractTestFromNode(this.uri, ast, node, parent, thisGeneration);
        if (!newItem) {
          ts.forEachChild(node, traverse);
          return;
        }

        const existing = parent.children.get(newItem.id);
        if (existing) {
          // location is the only thing that changes in existing items
          if (!locationEquals(existing.location, newItem.location)) {
            existing.location = newItem.location;
          }
          existing.generation = thisGeneration;
          existing.invalidate();
        } else {
          parent.children.add(newItem);
        }

        const finalItem = existing || newItem;
        if (finalItem instanceof TestSuite) {
          parents.push(finalItem);
          ts.forEachChild(node, traverse);
          parents.pop();
        }
      };

      ts.forEachChild(ast, traverse);
      this.prune(thisGeneration);
    } catch (e) {
      console.warn('Error reading tests in file', this.uri.toString(), e);
    }
  }

  /**
   * @override
   */
  public discoverChildren(progress: Progress<{ busy: boolean }>) {
    // note that triggering changes is handled by the parent WorkspaceTestRoot
    // or DocumentTestRoot, so we don't need to set up another watcher here.
    this.refresh().then(() => progress.report({ busy: false }));
  }

  /**
   * Removes tests that were deleted from the source. Each test suite and case
   * has a 'generation' counter which is updated each time we discover it. This
   * is called after discovery is finished to remove any children who are no
   * longer in this generation.
   */
  private prune(thisGeneration: number) {
    const queue: (TestSuite | TestFile)[] = [this];
    for (const parent of queue) {
      for (const child of parent.children) {
        if (child.generation < thisGeneration) {
          parent.children.delete(child);
        } else if (child instanceof TestSuite) {
          queue.push(child);
        }
      }
    }
  }
}

export class TestSuite extends TestItem<TestSuite | TestCase> {
  public readonly runnable = true;
  public readonly debuggable = true;

  constructor(
    public readonly label: string,
    public location: Location,
    public generation: number,
    public readonly parent: TestSuite | TestFile
  ) {
    super(
      parent instanceof TestSuite ? `${parent.id} ${label}` : idPrefix + label,
      label || '<empty>',
      true
    );
  }
}

export class TestCase extends TestItem {
  public readonly runnable = true;
  public readonly debuggable = true;

  constructor(
    public readonly label: string,
    public location: Location,
    public generation: number,
    public readonly parent: TestFile | TestSuite
  ) {
    super(
      parent instanceof TestSuite ? `${parent.id} ${label}` : idPrefix + label,
      label || '<empty>',
      false
    );
  }
}

export type VSCodeTest = TestRoot | TestFile | TestSuite | TestCase;
