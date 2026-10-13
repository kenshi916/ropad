'use strict';
// Fixed reviewed gameplay shared by Studio assembly and downloadable projects.
const GAMEPLAY_SOURCE = `-- Parallax starter gameplay | assembled is not the same as playtested
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local root = script.Parent
local template = root:GetAttribute("Template")
local checkpoints, started, purchases, debounce = {}, {}, {}, {}
local lastTimes, bestTimes, records, huds, characterConnections = {}, {}, {}, {}, {}
local requiredCheckpoints = 0
for _, part in ipairs(root:GetChildren()) do
 if part:IsA("BasePart") and part:GetAttribute("Behavior") == "checkpoint" then requiredCheckpoints = math.max(requiredCheckpoints, part:GetAttribute("Value") or 0) end
end
local function stats(player)
 local folder = player:FindFirstChild("ParallaxStats")
 if not folder then folder = Instance.new("Folder"); folder.Name = "ParallaxStats"; folder.Parent = player end
 for _, name in ipairs({"Coins", "Stage", "Wins", "Upgrades"}) do
  if not folder:FindFirstChild(name) then local value = Instance.new("IntValue"); value.Name = name; value.Parent = folder end
 end
 return folder
end
local function show(part, label)
 local gui = Instance.new("BillboardGui"); gui.Name = "Hint"; gui.Size = UDim2.fromOffset(180, 42); gui.StudsOffset = Vector3.new(0, 4, 0); gui.AlwaysOnTop = true; gui.Parent = part
 local text = Instance.new("TextLabel"); text.Size = UDim2.fromScale(1, 1); text.BackgroundTransparency = .25; text.BackgroundColor3 = Color3.fromRGB(15, 20, 30); text.TextColor3 = Color3.new(1, 1, 1); text.Font = Enum.Font.GothamBold; text.TextSize = 14; text.Text = label; text.Parent = gui
end
local function timeText(seconds)
 return seconds and string.format("%.2fs", seconds) or "--"
end
local function renderHud(player, now)
 local hud = huds[player]
 if not hud or not hud.gui.Parent then return end
 local scores = stats(player)
 local elapsed = started[player] and math.max(0, now - started[player]) or lastTimes[player]
 hud.time.Text = "TIME " .. timeText(elapsed) .. "     SESSION BEST " .. timeText(bestTimes[player])
 local progress = template == "racing" and ("GATES " .. scores.Stage.Value .. " / " .. requiredCheckpoints) or (template == "tycoon" and ("UPGRADES " .. scores.Upgrades.Value) or ("CHECKPOINT " .. scores.Stage.Value))
 hud.progress.Text = progress .. "     COINS " .. scores.Coins.Value .. "     WINS " .. scores.Wins.Value
 if started[player] then
  hud.status.Text = template == "racing" and "Follow the numbered gates in order" or (template == "tycoon" and "Collect coins and buy the required upgrades" or "Follow the checkpoints to the finish")
 elseif lastTimes[player] then
  hud.status.Text = (records[player] and "NEW SESSION BEST  " or "FINISHED  ") .. timeText(lastTimes[player]) .. "  /  Return to START to replay"
 else hud.status.Text = "Touch START to begin  /  Progress is not saved between sessions" end
end
local function attachHud(player)
 local playerGui = player:WaitForChild("PlayerGui", 10)
 if not playerGui or not player.Parent or not root.Parent or huds[player] then return end
 local gui = Instance.new("ScreenGui"); gui.Name = "RopadRunHUD_" .. root.Name; gui.ResetOnSpawn = false; gui.DisplayOrder = 10
 local panel = Instance.new("Frame"); panel.Name = "RunPanel"; panel.AnchorPoint = Vector2.new(.5, 0); panel.Position = UDim2.new(.5, 0, 0, 8); panel.Size = UDim2.new(.92, 0, 0, 94); panel.BackgroundColor3 = Color3.fromRGB(15, 25, 25); panel.BackgroundTransparency = .08; panel.BorderSizePixel = 0; panel.Parent = gui
 local bounds = Instance.new("UISizeConstraint"); bounds.MaxSize = Vector2.new(600, 94); bounds.Parent = panel
 local function label(name, top, height, color)
  local text = Instance.new("TextLabel"); text.Name = name; text.Position = UDim2.new(0, 10, 0, top); text.Size = UDim2.new(1, -20, 0, height); text.BackgroundTransparency = 1; text.TextColor3 = color; text.Font = Enum.Font.GothamBold; text.TextScaled = true; text.TextWrapped = true; text.Parent = panel
  local size = Instance.new("UITextSizeConstraint"); size.MinTextSize = 10; size.MaxTextSize = name == "Time" and 18 or 13; size.Parent = text
  return text
 end
 huds[player] = {gui=gui, time=label("Time", 8, 26, Color3.fromRGB(169, 255, 218)), progress=label("Progress", 37, 20, Color3.fromRGB(230, 237, 230)), status=label("Status", 61, 25, Color3.fromRGB(196, 209, 202))}
 gui.Parent = playerGui
 renderHud(player, os.clock())
end
local function onPlayer(player)
 stats(player)
 characterConnections[player] = player.CharacterAdded:Connect(function(character)
  local humanoidRoot = character:WaitForChild("HumanoidRootPart", 10)
  if humanoidRoot and checkpoints[player] then character:PivotTo(checkpoints[player].CFrame + Vector3.new(0, 5, 0)) end
  -- The active run and best time survive death; the clock keeps running.
  task.spawn(attachHud, player)
 end)
 task.spawn(attachHud, player)
end
local playerAdded = Players.PlayerAdded:Connect(onPlayer)
for _, player in ipairs(Players:GetPlayers()) do onPlayer(player) end
local playerRemoving = Players.PlayerRemoving:Connect(function(player)
 checkpoints[player] = nil; started[player] = nil; purchases[player] = nil; debounce[player] = nil; lastTimes[player] = nil; bestTimes[player] = nil; records[player] = nil
 if characterConnections[player] then characterConnections[player]:Disconnect(); characterConnections[player] = nil end
 if huds[player] then huds[player].gui:Destroy(); huds[player] = nil end
end)
local accumulated = 0
local heartbeat = RunService.Heartbeat:Connect(function(delta)
 accumulated += delta
 if accumulated < .1 then return end
 accumulated = 0
 local now = os.clock()
 for player in pairs(huds) do renderHud(player, now) end
end)
root.Destroying:Connect(function()
 heartbeat:Disconnect(); playerAdded:Disconnect(); playerRemoving:Disconnect()
 for _, connection in pairs(characterConnections) do connection:Disconnect() end
 for _, hud in pairs(huds) do hud.gui:Destroy() end
 table.clear(huds)
end)
for _, part in ipairs(root:GetChildren()) do
 if not part:IsA("BasePart") then continue end
 local behavior = part:GetAttribute("Behavior")
 local value = part:GetAttribute("Value") or 1
 if behavior == "spawn" then show(part, template == "racing" and ("START / Follow " .. requiredCheckpoints .. " gates") or "START / Collect coins and reach the finish") end
 if behavior == "checkpoint" then show(part, "CHECKPOINT " .. value) end
 if behavior == "finish" then show(part, template == "tycoon" and ("FINISH / Buy " .. value .. " upgrades") or "FINISH") end
 if behavior == "purchase" then show(part, "UPGRADE / " .. value .. " coins") end
 if behavior == "solid" then continue end
 part.Touched:Connect(function(hit)
  local character = hit:FindFirstAncestorOfClass("Model")
  local player = character and Players:GetPlayerFromCharacter(character)
  local humanoid = character and character:FindFirstChildOfClass("Humanoid")
  if not player or not humanoid or humanoid.Health <= 0 then return end
  debounce[player] = debounce[player] or {}
  local now = os.clock()
  if (debounce[player][part] or 0) > now then return end
  debounce[player][part] = now + 1
  local scores = stats(player)
  if behavior == "spawn" then
   if not started[player] then started[player] = now; records[player] = nil end
  elseif behavior == "hazard" then humanoid.Health = 0
  elseif behavior == "checkpoint" then
   if started[player] and (template ~= "racing" or value == scores.Stage.Value + 1) then
    if value > scores.Stage.Value then scores.Stage.Value = value; checkpoints[player] = part end
   end
  elseif behavior == "coin" then
   if part:GetAttribute("Collected") then return end
   part:SetAttribute("Collected", true); part.Transparency = 1; part.CanTouch = false; scores.Coins.Value += value
   task.delay(8, function() if part.Parent then part:SetAttribute("Collected", false); part.Transparency = 0; part.CanTouch = true end end)
  elseif behavior == "purchase" then
   purchases[player] = purchases[player] or {}
   if not purchases[player][part] and scores.Coins.Value >= value then
    purchases[player][part] = true; scores.Coins.Value -= value; scores.Upgrades.Value += 1
    local upgrade = Instance.new("Part"); upgrade.Name = player.Name .. "Upgrade"; upgrade.Anchored = true; upgrade.Size = Vector3.new(8, 6 + scores.Upgrades.Value * 3, 8); upgrade.Position = part.Position + Vector3.new(0, upgrade.Size.Y / 2, -10); upgrade.Color = part.Color; upgrade.Parent = root
   end
  elseif behavior == "finish" then
   if template == "tycoon" and scores.Upgrades.Value < value then return end
   if template == "racing" and scores.Stage.Value < requiredCheckpoints then return end
   if not started[player] then return end
   local elapsed = math.floor(math.max(0, now - started[player]) * 100) / 100
   records[player] = not bestTimes[player] or elapsed < bestTimes[player]
   lastTimes[player] = elapsed
   if records[player] then bestTimes[player] = elapsed end
   scores.Wins.Value += 1; player:SetAttribute("ParallaxLastRunSeconds", elapsed); player:SetAttribute("RopadBestRunSeconds", bestTimes[player])
   started[player] = nil; checkpoints[player] = nil; scores.Stage.Value = 0
   print(player.Name .. " completed " .. root.Name .. " in " .. player:GetAttribute("ParallaxLastRunSeconds") .. " seconds")
  end
  renderHud(player, now)
 end)
end
`;
module.exports={GAMEPLAY_SOURCE};
