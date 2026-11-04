$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$owned=Get-Process -Name 'Code - Insiders' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*SF P5 owned probe*' }
$results=@()
foreach($process in $owned){
 $element=[Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
 $nodes=$element.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
 $labels=@()
 foreach($node in $nodes){$name=$node.Current.Name;if($name -match '(?i)^(Sign in|Sign In|Sign in to|Copilot|Canvases|Canvas|No canvases|Select a|Do you trust|Yes, I trust|Restricted Mode|Manage Workspace Trust|GitHub)'){$labels+=$name}}
 $results+=@{pid=$process.Id;title=$process.MainWindowTitle;labels=@($labels|Select-Object -Unique -First 40)}
}
@{scope='SF P5 owned probe windows only';windows=$results}|ConvertTo-Json -Depth 5 -Compress
