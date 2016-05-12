'use strict';

import * as vscode from 'vscode';
import {extname, dirname, join} from 'path';
import {exec} from 'child_process';
import {fuzzyDefinitionSearch} from './search';

export function activate(context: vscode.ExtensionContext) {

    let config = vscode.workspace.getConfiguration('fuzzydefinitions');
    let registrations: vscode.Disposable[] = [];

    registrations.push(vscode.commands.registerTextEditorCommand('editor.gotoFuzzyDefinitions', editor => {

        let {document, selection} = editor;

        return fuzzyDefinitionSearch(document, selection.active, new vscode.CancellationTokenSource().token).then(locations => {

            if (!locations || locations.length === 0) {
                let range = document.getWordRangeAtPosition(selection.active);
                let message = range ? 'unable to find' : 'unable to find ' + document.getText(range);
                vscode.window.setStatusBarMessage(message, 1500);
                return;
            }

            if (locations.length === 1) {
                return openLocation(locations[0]);
            }

            let picks = locations.map(l => ({
                label: `${vscode.workspace.asRelativePath(l.uri)}:${l.range.start.line + 1}`,
                description: l.uri.fsPath,
                location: l
            }));

            return vscode.window.showQuickPick(picks).then(pick => {
                return pick && openLocation(pick.location);
            });
        });
    }));

    // pretend to be a definition provider
    if (config.get<boolean>('integrateWithGoToDefinition')) {
        registrations.push(vscode.languages.registerDefinitionProvider('javascript', { provideDefinition: fuzzyDefinitionSearch }));
    }

    context.subscriptions.push(...registrations);
}

function openLocation(location: vscode.Location) {
    return vscode.workspace.openTextDocument(location.uri).then(doc => {
        return vscode.window.showTextDocument(doc).then(editor => {
            editor.revealRange(location.range);
        });
    });
}
