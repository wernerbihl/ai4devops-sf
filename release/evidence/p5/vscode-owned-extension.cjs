const vscode=require('vscode');const fs=require('node:fs');const path=require('node:path');
exports.activate=async()=>{const result={version:vscode.version,appName:vscode.env.appName,effectiveCanvasEnabled:vscode.workspace.getConfiguration('chat.canvases').get('enabled'),noModelTurnRequested:true};
try{const commands=await vscode.commands.getCommands(true);result.availableCanvasCommands=commands.filter(id=>id==='aiCustomization.openManagementEditor'||id==='workbench.action.agentSessions.openCanvas'||id==='workbench.action.agentSessions.reopenCanvas');
if(commands.includes('aiCustomization.openManagementEditor')){await vscode.commands.executeCommand('aiCustomization.openManagementEditor','canvases');result.commandResolved=true;}else result.commandResolved=false;
}catch(error){result.errorName=error.name;result.commandResolved=false;}fs.writeFileSync(path.join(__dirname,'..','extension-result.json'),JSON.stringify(result,null,2));};
