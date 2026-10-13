-- Ropad local Studio bridge
-- Install as a local plugin, open a blank place, then paste the build ID and worker token
-- This plugin only calls this machine's Ropad server and creates a new isolated folder
-- It does not publish, execute arbitrary model code, remove existing content, or capture your screen
local BASE_URL = "http://127.0.0.1:61281"
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Selection = game:GetService("Selection")
assert(plugin, "Install this file as a Studio plugin, not an in-game Script")
local toolbar = plugin:CreateToolbar("Ropad")
local toolbarButton = toolbar:CreateButton("Build connection", "Connect a local Ropad build", "")
local widget = plugin:CreateDockWidgetPluginGuiAsync("ParallaxLocalBuilderV1", DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, true, 400, 330, 340, 300))
widget.Title = "Ropad / Studio builder"
local frame = Instance.new("Frame"); frame.Size = UDim2.fromScale(1, 1); frame.BackgroundColor3 = Color3.fromRGB(15, 24, 22); frame.Parent = widget
local padding = Instance.new("UIPadding"); padding.PaddingLeft = UDim.new(0, 16); padding.PaddingRight = UDim.new(0, 16); padding.PaddingTop = UDim.new(0, 16); padding.Parent = frame
local layout = Instance.new("UIListLayout"); layout.Padding = UDim.new(0, 10); layout.SortOrder = Enum.SortOrder.LayoutOrder; layout.Parent = frame
local function label(value, height)
 local item = Instance.new("TextLabel"); item.BackgroundTransparency = 1; item.Size = UDim2.new(1, 0, 0, height); item.TextColor3 = Color3.fromRGB(221, 232, 224); item.TextSize = 14; item.Font = Enum.Font.Gotham; item.TextXAlignment = Enum.TextXAlignment.Left; item.TextWrapped = true; item.Text = value; item.Parent = frame; return item
end
label("Builds stay in this place until you review and publish them", 40)
local function input(placeholder)
 local item = Instance.new("TextBox"); item.Size = UDim2.new(1, 0, 0, 36); item.BackgroundColor3 = Color3.fromRGB(30, 43, 39); item.TextColor3 = Color3.fromRGB(240, 245, 240); item.PlaceholderText = placeholder; item.Text = ""; item.ClearTextOnFocus = false; item.TextSize = 12; item.Font = Enum.Font.Code; item.TextTruncate = Enum.TextTruncate.AtEnd; item.Parent = frame; return item
end
local sessionInput = input("Build ID from Ropad")
local tokenInput = input("Worker token (kept in memory only)")
local connectButton = Instance.new("TextButton"); connectButton.Size = UDim2.new(1, 0, 0, 38); connectButton.BackgroundColor3 = Color3.fromRGB(201, 239, 110); connectButton.TextColor3 = Color3.fromRGB(14, 25, 19); connectButton.TextSize = 14; connectButton.Font = Enum.Font.GothamBold; connectButton.Text = "Connect and apply this build"; connectButton.Parent = frame
local statusLabel = label("Disconnected / Open a blank place before connecting", 72)
local running = false
local generation = 0
local applying = false
local function trim(value) return value:match("^%s*(.-)%s*$") end
local function request(sessionId, token, method, suffix, payload)
 local response = HttpService:RequestAsync({Url = BASE_URL .. "/api/builds/" .. sessionId .. "/worker" .. suffix, Method = method, Headers = {Authorization = "Bearer " .. token, ["Content-Type"] = "application/json"}, Body = payload and HttpService:JSONEncode(payload) or nil})
 if not response.Success then error("Ropad HTTP " .. response.StatusCode .. " / " .. string.sub(response.Body, 1, 160)) end
 return HttpService:JSONDecode(response.Body)
end
local function acknowledge(sessionId, token, job, status, message, count)
 return request(sessionId, token, "POST", "/ack", {jobId = job.id, status = status, message = message, objectCount = count})
end
local function applyJob(sessionId, token, job, buildGeneration)
 assert(running and generation == buildGeneration, "Build connection was stopped")
 assert(RunService:IsEdit(), "Stop the playtest before applying a build")
 assert(type(job.id) == "string" and type(job.rootName) == "string" and job.rootName:match("^Parallax_%x+$"), "Invalid job identity")
 assert(type(job.plan) == "table" and #job.plan.parts >= 3 and #job.plan.parts <= 180, "Invalid scene size")
 assert(type(job.scriptSources) == "table" and #job.scriptSources == 1 and job.scriptSources[1].name == "ParallaxGameplay", "Unexpected gameplay source")
 assert(#job.scriptSources[1].source <= 18000, "Gameplay source too large")
 local existing = workspace:FindFirstChild(job.rootName)
 if existing then
  assert(existing:GetAttribute("ParallaxJob") == job.id and existing:GetAttribute("ParallaxComplete") == true, "A conflicting folder already exists; inspect it manually")
  assert(#existing:GetChildren() == #job.plan.parts + 1, "The existing completed folder has changed; inspect it manually")
  local seen = {}
  for _, part in ipairs(existing:GetChildren()) do if part:IsA("BasePart") then seen[part:GetAttribute("PlanId") or ""] = true end end
  for _, item in ipairs(job.plan.parts) do assert(seen[item.id], "A previously assembled scene object is missing") end
  assert(existing:FindFirstChild("ParallaxGameplay") and existing.ParallaxGameplay:IsA("Script"), "The gameplay Script is missing")
  return #existing:GetChildren()
 end
 acknowledge(sessionId, token, job, "building", "Studio is creating scene geometry and starter gameplay")
 local recording = ChangeHistoryService:TryBeginRecording("ParallaxBuild", "Apply Ropad build")
 assert(recording, "Another Studio recording is active; try again after it finishes")
 local root = Instance.new("Folder")
 root.Name = job.rootName; root:SetAttribute("ParallaxJob", job.id); root:SetAttribute("Template", job.plan.template); root:SetAttribute("ParallaxComplete", false)
 local ok, problem = pcall(function()
  root.Parent = workspace
  for index, item in ipairs(job.plan.parts) do
   assert(running and generation == buildGeneration, "Build connection was stopped; this attempt was canceled")
   assert(RunService:IsEdit(), "Play mode started during assembly; stop Play and inspect the build")
   local part = Instance.new(item.behavior == "spawn" and "SpawnLocation" or "Part")
   part.Name = item.name; part.Anchored = true; part.Size = Vector3.new(table.unpack(item.size)); part.Position = Vector3.new(table.unpack(item.position)); part.Color = Color3.fromRGB(table.unpack(item.color)); part.Material = Enum.Material[item.material]
   part:SetAttribute("PlanId", item.id); part:SetAttribute("Behavior", item.behavior); part:SetAttribute("Value", item.value)
   if item.behavior == "coin" then part.Shape = Enum.PartType.Ball; part.CanCollide = false end
   if part:IsA("SpawnLocation") then part.Neutral = true; part.Duration = 0 end
   part.Parent = root
   if index % 10 == 0 or index == #job.plan.parts then
    statusLabel.Text = "Studio created " .. index .. " / " .. #job.plan.parts .. " scene objects"
    pcall(acknowledge, sessionId, token, job, "building", "Studio created " .. index .. " of " .. #job.plan.parts .. " scene objects", index)
    task.wait()
   end
  end
  assert(running and generation == buildGeneration, "Build connection was stopped; this attempt was canceled")
  assert(RunService:IsEdit(), "Play mode started during assembly; stop Play and inspect the build")
  local gameplay = Instance.new("Script"); gameplay.Name = "ParallaxGameplay"
  ScriptEditorService:UpdateSourceAsync(gameplay, function() return job.scriptSources[1].source end)
  gameplay.Parent = root
  root:SetAttribute("ParallaxComplete", true)
 end)
 if not ok then
  -- Cancel this plugin's recording: remove only changes from this build attempt
  ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
  if root.Parent == nil then root:Destroy() end
  error(problem)
 end
 ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
 Selection:Set({root})
 return #root:GetChildren()
end
local function stop()
 running = false; generation += 1; tokenInput.Text = ""; connectButton.Text = "Connect and apply this build"; statusLabel.Text = "Disconnected / Your existing build has been kept"
end
connectButton.MouseButton1Click:Connect(function()
 if running then stop(); return end
 if applying then statusLabel.Text = "Finishing cancellation of the previous build; connect again in a moment"; return end
 local sessionId = trim(sessionInput.Text)
 local token = trim(tokenInput.Text)
 if not sessionId:match("^[%x%-]+$") or #sessionId ~= 36 or not token:match("^%x+$") or #token ~= 64 then statusLabel.Text = "Paste a valid build ID and the 64-character connection token"; return end
 if not RunService:IsEdit() then statusLabel.Text = "Stop Play mode before connecting"; return end
 running = true; generation += 1; local ownGeneration = generation
 tokenInput.Text = ""; connectButton.Text = "Disconnect"; statusLabel.Text = "Connecting to the local Ropad server"
 task.spawn(function()
  while running and generation == ownGeneration do
   local ok, result = pcall(request, sessionId, token, "GET", "", nil)
   if ok and result.job then
    statusLabel.Text = "Applying " .. result.job.gameName .. " / " .. #result.job.plan.parts .. " scene objects"
    applying = true
    local applied, problem = pcall(applyJob, sessionId, token, result.job, ownGeneration)
    applying = false
    if applied then
     local recorded = pcall(acknowledge, sessionId, token, result.job, "ready", "Studio confirmed scene assembly; press Play to test before publishing", problem)
     statusLabel.Text = recorded and "Scene assembled / Press Play to test / Publishing stays manual" or "Scene assembled / Reconnecting to record completion"
    else
     statusLabel.Text = "Build stopped / " .. tostring(problem)
     -- Keep the failure visible locally even when the server cannot receive the acknowledgment
     pcall(acknowledge, sessionId, token, result.job, "failed", string.sub(tostring(problem), 1, 500))
     running = false; connectButton.Text = "Connect and apply this build"; break
    end
   elseif ok then statusLabel.Text = result.status == "ready" and "Studio connected / Scene assembled / Playtest remains manual" or "Studio connected / " .. tostring(result.status)
   else statusLabel.Text = "Connection unavailable / " .. tostring(result) end
   task.wait(3)
  end
  token = nil
 end)
end)
toolbarButton.Click:Connect(function() widget.Enabled = not widget.Enabled end)
plugin.Unloading:Connect(stop)
