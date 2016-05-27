'use strict';

import * as vscode from 'vscode';
import {extname, dirname, join} from 'path';
import {exec} from 'child_process';

export function fuzzyDefinitionSearch(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken) {
    if (document.getWordRangeAtPosition(pos)) {
        return Promise.all([
            delegatingDefinitionSearch(document, pos, token),
            nakDefinitionSearch(document, pos, token)
        ]).then(values => {
            let [first, second] = values;
            let all = first.concat(second);
            dedup(all);
            return all;
        });
    }
}

function dedup(locations: vscode.Location[]){
    locations.sort((a, b) => {
        if (a.uri.toString() < b.uri.toString()) {
            return -1;
        } else if (a.uri.toString() > b.uri.toString()) {
            return 1;
        } else {
            return a.range.start.compareTo(b.range.start);
        }
    });

    let last = locations[0];
    for (let i = 1; i < locations.length; i++){
        let loc = locations[i];

        if (loc.uri.toString() === last.uri.toString()
            && loc.range.intersection(last.range)) {

            locations.splice(i, 1);
            i--;

        } else {
            last = loc;
        }
    }
}

function delegatingDefinitionSearch(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): PromiseLike<vscode.Location[]> {
    let range = document.getWordRangeAtPosition(pos);
    let word = document.getText(range);

    return vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', word).then(symbols => {
        let result: vscode.Location[] = [];
        for (let symbol of symbols) {
            let {location} = symbol;
            if (extname(location.uri.fsPath) === extname(document.fileName)) {
                result.push(location);
            }
        }
        return result;
    });
}

function nakDefinitionSearch(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): PromiseLike<vscode.Location[]> {

    return new Promise<vscode.Location[]>((resolve, reject) => {

        // let node = process.argv[0];
        let module = join(require.resolve('nak'), '../../bin/nak');
        let range = document.getWordRangeAtPosition(pos);
        let word = document.getText(range);
        let pattern = `(let|const|var|function|class)\\s+${word}|${word}\\s*:`
        let cmd = `node ${module} --ackmate -G "*${extname(document.fileName)}" -d "*node_modules*" "${pattern}" ${vscode.workspace.rootPath}`;
        const nak = exec(cmd, (err, stdout, stderr) => {
            if (err || stderr) {
                return reject(err || stderr);
            }

            let result: vscode.Location[] = [];
            let lines = stdout.split('\n');
            let lastUri: vscode.Uri;
            let lastMatch: RegExpMatchArray;

            for (let line of lines) {
                if (line[0] === ':') {
                    lastUri = vscode.Uri.file(line.substr(1));
                } else if (lastMatch = /^(\d+);\d+ (\d+)/.exec(line)) {
                    let line = parseInt(lastMatch[1]) - 1;
                    let end = parseInt(lastMatch[2]);
                    range = new vscode.Range(line, end - word.length + 1, line, end);

                    if (lastUri.toString() !== document.uri.toString() || !range.contains(pos)) {
                        result.push(new vscode.Location(lastUri, range));
                    }
                }
            }

            resolve(result);
        });

        // wait no longer then 2sec for nak
        setTimeout(() => {
            resolve([]);
            nak.kill();
        }, 2000);

        token.onCancellationRequested(() => nak.kill());
    });
}
