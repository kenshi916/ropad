-- Reusable presentation derived from the authored Skyline HUD. Read-only view
-- of server stats; custom scripts can add their own original interactive UI.
local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")
local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")
local stats = player:WaitForChild("ParallaxStats", 30)
local oldGui = playerGui:WaitForChild("RopadRunHUD_" .. root.Name, 30)
if not stats or not oldGui then return end
local oldPanel = oldGui:WaitForChild("RunPanel", 30)
if not oldPanel then return end
local oldTime = oldPanel:WaitForChild("Time", 30)
local oldProgress = oldPanel:WaitForChild("Progress", 30)
local oldStatus = oldPanel:WaitForChild("Status", 30)
if not oldTime or not oldProgress or not oldStatus then return end
local accent = Color3.fromRGB(table.unpack(HUD.accent))
local panelColor = Color3.fromRGB(table.unpack(HUD.panel))
local function create(kind, props, parent)
 local item = Instance.new(kind)
 for key, value in pairs(props) do item[key] = value end
 item.Parent = parent
 return item
end
local function rounded(parent, radius)
 create("UICorner", {CornerRadius=UDim.new(0,radius)}, parent)
end
local function label(parent,name,text,size,color,position,bounds)
 return create("TextLabel",{Name=name,Text=text,TextSize=size,Font=Enum.Font.GothamBold,TextColor3=color,BackgroundTransparency=1,Position=position,Size=bounds,TextXAlignment=Enum.TextXAlignment.Left,TextTruncate=Enum.TextTruncate.AtEnd},parent)
end
local gui = create("ScreenGui",{Name="RopadPresentation_"..root.Name,ResetOnSpawn=false,DisplayOrder=25,IgnoreGuiInset=false},playerGui)
local card = create("Frame",{Name="RunCard",AnchorPoint=Vector2.new(.5,0),Position=UDim2.new(.5,0,0,10),Size=UDim2.fromOffset(400,112),BackgroundColor3=panelColor,BackgroundTransparency=.06,BorderSizePixel=0},gui)
rounded(card,16)
create("UIStroke",{Color=accent,Transparency=.6,Thickness=1},card)
local scale = create("UIScale",{Scale=1},card)
label(card,"Title",HUD.title:upper(),12,accent,UDim2.fromOffset(18,10),UDim2.fromOffset(364,18))
local clock = label(card,"Timer","--",30,Color3.fromRGB(245,250,250),UDim2.fromOffset(18,30),UDim2.fromOffset(155,36))
local best = label(card,"Best","SESSION BEST --",11,Color3.fromRGB(167,186,196),UDim2.fromOffset(182,40),UDim2.fromOffset(198,22))
best.TextXAlignment=Enum.TextXAlignment.Right
create("Frame",{Position=UDim2.fromOffset(18,75),Size=UDim2.new(1,-36,0,1),BorderSizePixel=0,BackgroundColor3=accent,BackgroundTransparency=.75},card)
local progress = label(card,"Progress","Waiting for progress",11,Color3.fromRGB(215,233,233),UDim2.fromOffset(18,82),UDim2.fromOffset(364,20))
local hint = label(gui,"Objective","",13,Color3.fromRGB(245,250,250),UDim2.new(.5,-220,0,134),UDim2.fromOffset(440,30))
hint.TextXAlignment=Enum.TextXAlignment.Center
hint.BackgroundTransparency=.08;hint.BackgroundColor3=panelColor;rounded(hint,10)
local toast = label(gui,"Feedback","",14,panelColor,UDim2.new(.5,-140,0,174),UDim2.fromOffset(280,38))
toast.TextXAlignment=Enum.TextXAlignment.Center;toast.BackgroundColor3=accent;toast.BackgroundTransparency=0;toast.Visible=false;rounded(toast,10)
local result = create("Frame",{Name="RunResult",AnchorPoint=Vector2.new(.5,.5),Position=UDim2.fromScale(.5,.5),Size=UDim2.fromOffset(360,212),BackgroundColor3=panelColor,BorderSizePixel=0,Visible=false},gui)
rounded(result,18);create("UIStroke",{Color=accent,Transparency=.5},result)
local resultScale=create("UIScale",{Scale=1},result)
label(result,"Eyebrow","RUN COMPLETE",12,accent,UDim2.fromOffset(22,18),UDim2.fromOffset(280,20))
local resultTime=label(result,"Time","--",46,Color3.new(1,1,1),UDim2.fromOffset(22,50),UDim2.fromOffset(310,65))
local resultBest=label(result,"Best","",13,accent,UDim2.fromOffset(22,126),UDim2.fromOffset(310,25))
label(result,"Replay","Return to START to play again",13,Color3.fromRGB(167,186,196),UDim2.fromOffset(22,167),UDim2.fromOffset(310,25))
local close=create("TextButton",{Name="Dismiss",Text="×",Font=Enum.Font.GothamBold,TextSize=24,TextColor3=Color3.new(1,1,1),BackgroundTransparency=1,Position=UDim2.new(1,-48,0,4),Size=UDim2.fromOffset(44,44)},result)
close.Activated:Connect(function()result.Visible=false end)
local connections={}
local function connect(signal,fn)table.insert(connections,signal:Connect(fn))end
local function refresh()
 oldGui.Enabled=false
 clock.Text=oldTime.Text:match("^TIME%s+(%S+)") or "--"
 best.Text="SESSION BEST "..(oldTime.Text:match("SESSION BEST%s+(%S+)")or"--")
 progress.Text=oldProgress.Text
 hint.Text=oldStatus.Text
end
local lastStage=stats:WaitForChild("Stage").Value
local sequence=0
connect(stats.Stage.Changed,function(value)
 if value>lastStage then
  sequence+=1;local at=sequence;toast.Text="CHECKPOINT "..tostring(value).."  SECURED";toast.Visible=true;toast.TextTransparency=0
  task.delay(1.7,function()if at~=sequence or not toast.Parent then return end;TweenService:Create(toast,TweenInfo.new(.25),{TextTransparency=1}):Play();task.delay(.25,function()if at==sequence and toast.Parent then toast.Visible=false end end)end)
 end
 lastStage=value
end)
local wins=stats:WaitForChild("Wins");local lastWins=wins.Value
connect(wins.Changed,function(value)
 if value>lastWins then
  task.defer(function()
   if not gui.Parent then return end
   local seconds=player:GetAttribute("ParallaxLastRunSeconds")
   local record=player:GetAttribute("RopadBestRunSeconds")
   resultTime.Text=type(seconds)=="number" and string.format("%.2fs",seconds)or"Complete"
   resultBest.Text="SESSION BEST "..(type(record)=="number" and string.format("%.2fs",record)or"--")
   result.Visible=true
  end)
 end
 lastWins=value
end)
local function resize()
 local camera=workspace.CurrentCamera;if not camera then return end
 local width,height=camera.ViewportSize.X,camera.ViewportSize.Y
 local factor=math.clamp((width-24)/400,.55,1);scale.Scale=factor;resultScale.Scale=factor
 local compact=height<500 and width>height
 card.Position=UDim2.new(.5,0,0,compact and 4 or 10)
 hint.Position=UDim2.new(.5,-math.min(220,(width-24)/2),0,112*factor+(compact and 8 or 20))
 hint.Size=UDim2.fromOffset(math.min(440,width-24),28)
 toast.Position=UDim2.new(.5,-140,0,112*factor+54)
 close.Size=UDim2.fromOffset(44/factor,44/factor)
end
local cameraConnection
local function cameraChanged()
 if cameraConnection then cameraConnection:Disconnect()end
 if workspace.CurrentCamera then cameraConnection=workspace.CurrentCamera:GetPropertyChangedSignal("ViewportSize"):Connect(resize)end
 resize()
end
for _,item in ipairs({oldTime,oldProgress,oldStatus})do connect(item:GetPropertyChangedSignal("Text"),refresh)end
connect(workspace:GetPropertyChangedSignal("CurrentCamera"),cameraChanged)
connect(root.AncestryChanged,function()gui.Enabled=root:IsDescendantOf(workspace)end)
script.Destroying:Connect(function()for _,c in ipairs(connections)do c:Disconnect()end;if cameraConnection then cameraConnection:Disconnect()end;if oldGui.Parent then oldGui.Enabled=true end;gui:Destroy()end)
refresh();cameraChanged()
