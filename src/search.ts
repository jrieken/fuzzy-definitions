'use strict';

import * as vscode from 'vscode';
import {extname, dirname, join} from 'path';
import {exec} from 'child_process';
//import {which} from 'shelljs';
let which = require('shelljs').which;
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
        
        // Settings: TODO: Expose below extension settings to users (possibly pattern for advanced users too?)

        const timeoutMilliseconds = 2000; //milliseconds
        const timeoutAdditionalMillisecondsToForced = 1000;
        const reducedCpuPriorityUsed = false;
        const reducedCpuPriorityNiceValue = 10; //from 0 (normal) to 19 (lowest priority), or to -20 (if want higher/highest priority) 
        
        // Constants & Process Spawning Options:
        
        const timeoutMsFallback = timeoutMilliseconds + timeoutAdditionalMillisecondsToForced; //give exec a chance to kill process first
        const killSignal = 'SIGKILL'; // 'SIGKILL' (if want to force, so can't be ignored) | 'SIGTERM' (default, can be ignored)
        const options = { timeout: timeoutMilliseconds, killSignal: killSignal }; //: ExecOptions

        // Reduce CPU priority & usage, if enabled in extension settings (if expose those settings), since uses 100% of a CPU core otherwise (though less an issue now that timeout should be fixed)
        if (reducedCpuPriorityUsed) {
            if (which('nice')) {
                cmd = `nice -${reducedCpuPriorityNiceValue} ${cmd}`;
            }
        }

        // spawn a process (via node.exe) for regex search of all files with nak, an ack / grep like utility
        // FIXED Bug #2: by Dan (Dan@PowerSheet.ai) -- Fixed leaving many 100% CPU usage node.exe processes which never terminated. Added timeout via exec options. setTimeout might still fail to work (always or sometimes) as was the case before however.
        const searchProccess = exec(cmd, options, (err, stdout, stderr) => {
            if (err || stderr) {
                //TODO: Remove overhead of which() use from shelljs above by checking for error with failure to find path to nice.exe, if was used, and then re-exec without it instead
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

        // OR: alternative for CPU priority which can use to always support Windows too (even without Git or nice.exe in Path) (if change to correctly convert nice value to thread priority value)
        // if (reducedCpuPriorityUsed) {

        //     if (!which('renice') { //require('os').platform() == 'win32')
        //         exec(`wmic process where processid="${searchProccess.pid}" CALL setpriority ${-reducedCpuPriorityReniceValue}`); //TODO: needs rescaling, as uses opposite magnitude and very different scale
        //     } else {
        //         exec(`renice -n ${reducedCpuPriorityReniceValue} -p ${searchProccess.pid}`);
        //     }
        // }

        //fallback timeout use, kept just in case, even though now have added timeout via options param for exec(), and even though never seemed to work correctly before adding that.
        // wait no longer then 2 sec for nak
        setTimeout(() => {
            reject(`Fuzzy file search timed out, canceled as exceeded ${timeoutMsFallback} milliseconds`); //was resolve, changed to reject() now
            searchProccess.kill(killSignal);
        }, timeoutMsFallback);

        token.onCancellationRequested(() => searchProccess.kill(killSignal));
    });
}

