-- Offline engine-boundary fixture: real fixed Luau, mocked Roblox instances/events
local function signal()
 local listeners = {}
 return {
  Connect=function(_, fn)
   local entry = {active=true, fn=fn}; table.insert(listeners, entry)
   return {Disconnect=function() entry.active=false end}
  end,
  Fire=function(_, ...) for _, entry in ipairs(listeners) do if entry.active then entry.fn(...) end end end,
 }
end
local methods = {}
local meta = {
 __index=function(self, key)
  if methods[key] then return methods[key] end
  if self._props[key] ~= nil then return self._props[key] end
  for _, child in ipairs(self._children) do if child.Name == key then return child end end
 end,
 __newindex=function(self, key, value)
  if key == "Parent" then
   local old = self._props.Parent
   if old then for i, child in ipairs(old._children) do if child == self then table.remove(old._children, i); break end end end
   if value then table.insert(value._children, self) end
  end
  self._props[key] = value
 end,
}
function methods:GetChildren() return table.clone(self._children) end
function methods:IsA(class) return self.ClassName == class or class == "BasePart" and (self.ClassName == "Part" or self.ClassName == "SpawnLocation") end
function methods:FindFirstChild(name) for _, child in ipairs(self._children) do if child.Name == name then return child end end end
function methods:WaitForChild(name) return self:FindFirstChild(name) end
function methods:FindFirstChildOfClass(class) for _, child in ipairs(self._children) do if child:IsA(class) then return child end end end
function methods:FindFirstAncestorOfClass(class) local p=self.Parent; while p do if p:IsA(class) then return p end; p=p.Parent end end
function methods:GetAttribute(key) return self._attrs[key] end
function methods:SetAttribute(key, value) self._attrs[key]=value end
function methods:PivotTo(value) self._props.LastPivot=value end
function methods:Destroy() self.Destroying:Fire(); for _, child in ipairs(self:GetChildren()) do child:Destroy() end; self.Parent=nil; self._props.Destroyed=true end
local Instance={new=function(class)
 return setmetatable({_props={ClassName=class,Name=class,Value=0,Health=100,Destroying=signal(),Touched=signal()},_children={},_attrs={}},meta)
end}
local vecMeta={__add=function(a,b) return {X=a.X+b.X,Y=a.Y+b.Y,Z=a.Z+b.Z} end}
local Vector3={new=function(x,y,z) return setmetatable({X=x,Y=y,Z=z},vecMeta) end}
local Vector2={new=function(x,y) return {X=x,Y=y} end}
local UDim2={new=function(...) return {...} end,fromOffset=function(...) return {...} end,fromScale=function(...) return {...} end}
local Color3={new=function(...) return {...} end,fromRGB=function(...) return {...} end}
local Enum={Font={GothamBold="GothamBold"}}
local clock=0
local os={clock=function() return clock end}
local pendingDelays={}
local task={spawn=function(fn,...) fn(...) end,delay=function(delay,fn) table.insert(pendingDelays,{delay,fn}) end}
local fixtureWorld=Instance.new("Folder")
local fixtureRoot=Instance.new("Folder"); fixtureRoot.Name="FixtureRace"; fixtureRoot.Parent=fixtureWorld; fixtureRoot:SetAttribute("Template","racing")
local fixtureParts={}
for index, behavior in ipairs({"spawn","checkpoint","checkpoint","finish","hazard","coin"}) do
 local part=Instance.new(behavior=="spawn" and "SpawnLocation" or "Part"); part.Name="part"..index; part.CFrame=Vector3.new(index*10,4,0); part.Position=part.CFrame; part.Parent=fixtureRoot; part:SetAttribute("Behavior",behavior); part:SetAttribute("Value",behavior=="checkpoint" and index-1 or 1); fixtureParts[index]=part
end
local fixturePlayers=Instance.new("Players"); fixturePlayers.PlayerAdded=signal(); fixturePlayers.PlayerRemoving=signal()
local fixtureRunService={Heartbeat=signal()}
local function newCharacter(player)
 local character=Instance.new("Model"); character.Parent=fixtureWorld; character._props.Player=player
 local humanoid=Instance.new("Humanoid"); humanoid.Parent=character
 local hit=Instance.new("Part"); hit.Name="HumanoidRootPart"; hit.Parent=character
 return character,hit,humanoid
end
local function newPlayer(name)
 local player=Instance.new("Player"); player.Name=name; player.Parent=fixturePlayers; player.CharacterAdded=signal()
 local gui=Instance.new("PlayerGui"); gui.Name="PlayerGui"; gui.Parent=player
 local character,hit,humanoid=newCharacter(player); player.Character=character
 return player,hit,humanoid
end
local fixturePlayer,fixtureHit,fixtureHumanoid=newPlayer("Runner")
function fixturePlayers:GetPlayers() return self:GetChildren() end
function fixturePlayers:GetPlayerFromCharacter(character) return character.Player end
local game={GetService=function(_,name) if name=="Players" then return fixturePlayers elseif name=="RunService" then return fixtureRunService else error(name) end end}
local script={Parent=fixtureRoot}

-- FIXED_GAMEPLAY_SOURCE

local function equal(a,b,label) assert(a==b, label..": expected "..tostring(b)..", got "..tostring(a)) end
local function contains(value, expected, label) assert(string.find(value,expected,1,true),label..": "..value) end
local function touch(index, at) clock=at; fixtureParts[index].Touched:Fire(fixtureHit) end
local function heartbeat(at) clock=at; fixtureRunService.Heartbeat:Fire(.2) end
local gui=fixturePlayer.PlayerGui:FindFirstChild("RopadRunHUD_FixtureRace")
assert(gui,"player-visible run HUD missing")
equal(gui.ResetOnSpawn,false,"HUD survives respawn")
contains(gui.RunPanel.Time.Text,"SESSION BEST --","initial best time")
touch(2,1); equal(fixturePlayer.ParallaxStats.Stage.Value,0,"checkpoint cannot start or skip the start")
touch(4,2); equal(fixturePlayer.ParallaxStats.Wins.Value,0,"finish before run rejected")
touch(1,10); heartbeat(11.25); contains(gui.RunPanel.Time.Text,"TIME 1.25s","active elapsed time")
touch(1,12); heartbeat(12.5); contains(gui.RunPanel.Time.Text,"TIME 2.50s","touching start does not reset active run")
touch(3,13); equal(fixturePlayer.ParallaxStats.Stage.Value,0,"out-of-order gate rejected")
touch(2,14); equal(fixturePlayer.ParallaxStats.Stage.Value,1,"first gate accepted")
touch(4,14.5); equal(fixturePlayer.ParallaxStats.Wins.Value,0,"early finish rejected")
touch(5,15); equal(fixtureHumanoid.Health,0,"hazard triggers death")
local replacement; replacement,fixtureHit,fixtureHumanoid=newCharacter(fixturePlayer); fixturePlayer.Character=replacement; clock=18; fixturePlayer.CharacterAdded:Fire(replacement)
equal(replacement.LastPivot.X,fixtureParts[2].CFrame.X,"respawn uses last checkpoint")
equal(replacement.LastPivot.Y,fixtureParts[2].CFrame.Y+5,"respawn above checkpoint")
equal(fixturePlayer.PlayerGui:FindFirstChild("RopadRunHUD_FixtureRace"),gui,"respawn keeps same HUD")
heartbeat(18); contains(gui.RunPanel.Time.Text,"TIME 8.00s","death does not reset elapsed time")
touch(3,20); touch(4,25)
equal(fixturePlayer:GetAttribute("ParallaxLastRunSeconds"),15,"first finish elapsed")
equal(fixturePlayer:GetAttribute("RopadBestRunSeconds"),15,"first session best")
equal(fixturePlayer.ParallaxStats.Wins.Value,1,"first win")
equal(fixturePlayer.ParallaxStats.Stage.Value,0,"finish resets stages")
contains(gui.RunPanel.Status.Text,"NEW SESSION BEST","visible finish result")
contains(gui.RunPanel.Status.Text,"Return to START to replay","replay instruction")
touch(4,27); equal(fixturePlayer.ParallaxStats.Wins.Value,1,"repeated finish cannot duplicate win")
touch(1,30); touch(2,31); touch(3,32); touch(4,35)
equal(fixturePlayer:GetAttribute("RopadBestRunSeconds"),5,"faster replay improves best")
equal(fixturePlayer.ParallaxStats.Wins.Value,2,"second completed run")
touch(1,40); touch(2,41); touch(3,42); touch(4,50)
equal(fixturePlayer:GetAttribute("ParallaxLastRunSeconds"),10,"slower last time displayed separately")
equal(fixturePlayer:GetAttribute("RopadBestRunSeconds"),5,"slower replay preserves best")
contains(gui.RunPanel.Time.Text,"SESSION BEST 5.00s","best remains visible")
contains(gui.RunPanel.Status.Text,"FINISHED  10.00s","slower finish result")
fixturePlayers.PlayerRemoving:Fire(fixturePlayer); fixturePlayer.Parent=nil
equal(gui.Destroyed,true,"leave removes HUD")
local freshPlayer=newPlayer("Runner"); fixturePlayers.PlayerAdded:Fire(freshPlayer)
contains(freshPlayer.PlayerGui:FindFirstChild("RopadRunHUD_FixtureRace").RunPanel.Time.Text,"SESSION BEST --","rejoin starts a fresh session")
fixtureRoot:Destroy(); equal(#freshPlayer.PlayerGui:GetChildren(),0,"removing game cleans up HUD")
print("Fixed gameplay timing, replay, best-time, death and cleanup checks passed")
