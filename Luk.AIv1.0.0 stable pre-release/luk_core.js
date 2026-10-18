// =====================================================================
// LUK.AI - LOCAL OLLAMA CLIENT (IE/HTA compatible)
// =====================================================================

var workspacePath = "";
var sessionStoragePath = "";
var currentSessionId = "";
var currentSessionTitle = "New conversation";
var currentSessionFilename = "";
var currentSessionFolder = "";
var sessionTitleRequested = false;
var developerInstructions = "";
var LUKAI_SYSTEM_PROMPT = "You are LuK.AI, a natural, thoughtful, highly capable assistant. Speak clearly and conversationally without sounding robotic or excessively flattering. Understand the user's goal, answer directly, and organize complex answers into useful steps. Be rigorous: distinguish facts from assumptions, state uncertainty plainly, and never invent citations, test results, or capabilities. For coding tasks, provide correct, complete code and mention important edge cases. Ask a concise clarifying question only when the missing detail materially changes the answer. Keep simple answers short and substantive.Do not add too much or even any humor for serious tasks. Verify all URLs and code snippets for accuracy. Avoid repeating the user's question in your answer. If you cannot answer, say so clearly and suggest next steps. Do not irritate the user with unhelpful or useless information. ";
var chatHistoryLog = [];
var stagedFilePayload = null;
var requestInProgress = false;
var serverReady = false;
var modelWarming = false;
var installedModels = [];
var DEFAULT_MODEL = "gemma2:2b";
var activeModel = DEFAULT_MODEL;
var DEFAULT_CONTEXT_LENGTH = 4096;
var serverRetryCount = 0;
var serverRetryTimer = null;
var MAX_CONTEXT_FILE_SIZE = 2 * 1024 * 1024;
var MAX_CROSS_CHAT_CONTEXTS = 3;

function getSessionStoragePath(fso, localDataPath) {
    fso = fso || new ActiveXObject("Scripting.FileSystemObject");
    if (sessionStoragePath && fso.FolderExists(sessionStoragePath)) return sessionStoragePath;
    try {
        if (!localDataPath) {
            var shell = new ActiveXObject("WScript.Shell");
            localDataPath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%");
        }
        if (!localDataPath || localDataPath === "%LOCALAPPDATA%") throw new Error("Windows Local AppData is unavailable.");
        var appDataFolder = fso.BuildPath(localDataPath, "LuK.AI");
        if (!fso.FolderExists(appDataFolder)) fso.CreateFolder(appDataFolder);
        sessionStoragePath = fso.BuildPath(appDataFolder, "Sessions");
        if (!fso.FolderExists(sessionStoragePath)) fso.CreateFolder(sessionStoragePath);
        return sessionStoragePath;
    } catch (error) {
        if (workspacePath && fso.FolderExists(workspacePath)) {
            sessionStoragePath = workspacePath;
            return sessionStoragePath;
        }
        throw error;
    }
}

function initializeWorkspaceUI(resolvedPath, localDataPath) {
    var fso = null;
    var setupMessage = "";
    workspacePath = "";
    sessionStoragePath = "";
    try {
        fso = new ActiveXObject("Scripting.FileSystemObject");
        if (resolvedPath) {
            var candidatePath = fso.GetAbsolutePathName(resolvedPath);
            if (fso.FolderExists(candidatePath)) workspacePath = candidatePath;
            else setupMessage = "App folder not found; using per-user session storage.";
        }
    } catch (pathError) {
        setupMessage = "App folder unavailable; using per-user session storage.";
    }
    try {
        sessionStoragePath = getSessionStoragePath(fso, localDataPath);
    } catch (storageError) {
        setupMessage = "Session storage setup failed: " + storageError.message;
    }
    developerInstructions = loadDeveloperInstructions();

    if (sessionStoragePath || workspacePath) loadPreviousChatsList();
    else {
        var list = document.getElementById("historySectionList");
        if (list) list.innerText = "Session storage is unavailable.";
    }
    startNewConversationSession();
    if (setupMessage) setEngineStatus(setupMessage, "error");
    refreshModelCatalog();
}

function makeRequest(method, url, body, onComplete, onProgress) {
    var xhr = new XMLHttpRequest();
    var completed = false;
    function finish(error) {
        if (completed) return;
        completed = true;
        onComplete(xhr, error);
    }
    xhr.open(method, url, true);
    try { xhr.timeout = method === "GET" ? 5000 : 300000; } catch (ignoreTimeoutSupport) {}
    if (method === "POST") xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onerror = function () { finish("Network connection failed."); };
    xhr.ontimeout = function () { finish("The local engine did not respond in time."); };
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) finish(null);
        else if (onProgress && (xhr.readyState === 3)) onProgress(xhr.responseText || "", false);
    };
    try {
        xhr.send(body === null ? null : body);
    } catch (error) {
        finish(error.message || "Could not contact the local model service.");
    }
    return xhr;
}

function setEngineStatus(message, state) {
    var box = document.getElementById("engineStatus");
    var text = document.getElementById("engineStatusText");
    if (!box || !text) return;
    box.className = "status-box" + (state ? " " + state : "");
    text.innerText = message;
    var retry = document.getElementById("engineRetry");
    if (retry) retry.style.display = state === "error" ? "inline-block" : "none";
}

function retryEngineStartup() {
    if (serverRetryTimer !== null) {
        window.clearTimeout(serverRetryTimer);
        serverRetryTimer = null;
    }
    serverRetryCount = 0;
    setEngineStatus("Connecting to the LuK.AI engine…", "");
    refreshModelCatalog();
}

function scheduleEngineRetry(message) {
    serverReady = false;
    serverRetryCount++;
    setEngineStatus(message || "Connecting to the LuK.AI engine… Retrying automatically.", "");
    if (serverRetryTimer !== null) window.clearTimeout(serverRetryTimer);
    serverRetryTimer = window.setTimeout(function () {
        serverRetryTimer = null;
        refreshModelCatalog();
    }, 2000);
}

function refreshModelCatalog() {
    makeRequest("GET", "http://127.0.0.1:11434/api/tags", null, function (xhr, networkError) {
        if (networkError || xhr.status < 200 || xhr.status >= 300) {
            loadPreviousChatsList();
            scheduleEngineRetry("Connecting to the LuK.AI engine… Retrying automatically (attempt " + (serverRetryCount + 1) + ").");
            return;
        }
        try {
            if (serverRetryTimer !== null) {
                window.clearTimeout(serverRetryTimer);
                serverRetryTimer = null;
            }
            var result = JSON.parse(xhr.responseText || "{}");
            installedModels = result.models || [];
            serverRetryCount = 0;
            var approvedModel = getApprovedModelTag();
            if (approvedModel && isModelInstalled(approvedModel)) {
                activeModel = approvedModel;
                warmupModel(activeModel, "LuK.AI custom model is ready · " + activeModel, "connected");
            } else if (isModelInstalled(DEFAULT_MODEL)) {
                activeModel = DEFAULT_MODEL;
                warmupModel(activeModel, approvedModel ? "Approved custom model is missing; using Gemma fallback." : "LuK.AI is ready.", approvedModel ? "error" : "connected");
            } else {
                activeModel = approvedModel || DEFAULT_MODEL;
                scheduleEngineRetry(installedModels.length ? "Waiting for local model " + activeModel + "; retrying automatically." : "Connecting to the LuK.AI engine… Waiting for local models.");
            }
        } catch (error) {
            scheduleEngineRetry("LuK.AI returned an unreadable response. Retrying automatically.");
        }
    });
}

function warmupModel(modelName, readyMessage, readyState) {
    if (modelWarming) return;
    modelWarming = true;
    serverReady = false;
    setEngineStatus("Starting local model " + modelName + "…", "");
    makeRequest("POST", "http://127.0.0.1:11434/api/chat", JSON.stringify({
        model: modelName,
        messages: [{ role: "user", content: "Reply with OK." }],
        stream: false,
        keep_alive: "5m",
        options: { num_ctx: DEFAULT_CONTEXT_LENGTH, num_predict: 1 }
    }), function (xhr, networkError) {
        modelWarming = false;
        var warmupError = networkError;
        var result;
        if (!warmupError) {
            try {
                result = JSON.parse(xhr.responseText || "{}");
                if (xhr.status < 200 || xhr.status >= 300) warmupError = result.error || "HTTP " + xhr.status;
                else if (result.error) warmupError = result.error;
            } catch (error) {
                warmupError = "The model returned an unreadable startup response.";
            }
        }
        if (warmupError) {
            scheduleEngineRetry("Could not start local model " + modelName + ". Retrying automatically.");
            return;
        }
        serverReady = true;
        setEngineStatus(readyMessage, readyState);
    });
}

function isModelInstalled(modelName) {
    var i;
    for (i = 0; i < installedModels.length; i++) {
        if (String(installedModels[i].name || "").toLowerCase() === modelName.toLowerCase()) return true;
    }
    return false;
}

function loadDeveloperInstructions() {
    try {
        var fso = new ActiveXObject("Scripting.FileSystemObject");
        if (!sessionStoragePath || !fso.FolderExists(sessionStoragePath)) return "";
        var appDataFolder = fso.GetParentFolderName(sessionStoragePath);
        var instructionPath = fso.BuildPath(appDataFolder, "LUKAI_DEVELOPER_INSTRUCTIONS.txt");
        if (!fso.FileExists(instructionPath)) return "";
        var stream = fso.OpenTextFile(instructionPath, 1, false, 0);
        var instructions = stream.ReadAll();
        stream.Close();
        instructions = instructions.replace(/^\s+|\s+$/g, "");
        return instructions.substring(0, 8000);
    } catch (error) {
        return "";
    }
}

function getGenerationOptions() {
    return {
        num_ctx: DEFAULT_CONTEXT_LENGTH,
        num_predict: developerInstructions ? -1 : 512
    };
}

function getApprovedModelTag() {
    try {
        var fso = new ActiveXObject("Scripting.FileSystemObject");
        if (!sessionStoragePath || !fso.FolderExists(sessionStoragePath)) return "";
        var appDataFolder = fso.GetParentFolderName(sessionStoragePath);
        var approvalFile = fso.BuildPath(appDataFolder, "approved_model.txt");
        if (!fso.FileExists(approvalFile)) return "";
        var stream = fso.OpenTextFile(approvalFile, 1, false, 0);
        var modelTag = stream.ReadAll();
        stream.Close();
        modelTag = modelTag.replace(/^\s+|\s+$/g, "");
        return /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(modelTag) ? modelTag : "";
    } catch (error) {
        return "";
    }
}

function triggerFileInjector() {
    if (!requestInProgress) document.getElementById("hiddenFileInput").click();
}

function handleFileSelection() {
    var fileInput = document.getElementById("hiddenFileInput");
    if (!fileInput.files || fileInput.files.length === 0) return;
    var file = fileInput.files[0];
    fileInput.value = "";
    try {
        if (!/\.(txt|md|csv|json|xml|html?|css|js|ts|py|log|ya?ml|ini)$/i.test(file.name)) {
            alert("Choose a supported text file such as TXT, MD, CSV, JSON, HTML, JS, or PY.");
            return;
        }
        var fso = new ActiveXObject("Scripting.FileSystemObject");
        if (!fso.FileExists(file.path)) throw new Error("File not found.");
        if (fso.GetFile(file.path).Size > MAX_CONTEXT_FILE_SIZE) {
            alert("Please choose a text file smaller than 2 MB.");
            return;
        }
        var textStream = fso.OpenTextFile(file.path, 1, false, -2);
        var contents = textStream.ReadAll();
        textStream.Close();
        stagedFilePayload = { name: file.name, path: file.path, data: contents };
        renderStagingTray();
    } catch (error) {
        alert("Could not read that file. Choose a text-based file and check its permissions.");
    }
}

function processingPromptQueue() {
    if (requestInProgress) return;
    var textInput = document.getElementById("userInputText");
    var currentPrompt = textInput.value.replace(/^\s+|\s+$/g, "");
    if (!currentPrompt && !stagedFilePayload) return;
    if (modelWarming) {
        setEngineStatus("Starting local model " + activeModel + "… Please wait.", "");
        return;
    }
    if (!serverReady) {
        setEngineStatus("Connecting to the LuK.AI engine… Your message will stay here; retrying automatically.", "");
        retryEngineStartup();
        return;
    }
    if (!isModelInstalled(activeModel)) {
        setEngineStatus("The selected model is not installed locally: " + activeModel + ". Install it before using offline chat.", "error");
        return;
    }

    var payload = currentPrompt || "Please analyze the attached text file.";
    if (stagedFilePayload) {
        payload += "\n\n[Attached document: " + stagedFilePayload.name + "]\n---\n" + stagedFilePayload.data + "\n---";
    }
    var displayText = currentPrompt || "Please analyze the attached text file.";
    var fileToShow = stagedFilePayload;
    var userRow = createMessageRow("user", displayText);
    if (fileToShow) addAttachmentPill(userRow, "Document: " + fileToShow.name);
    document.getElementById("chatHistoryContainer").appendChild(userRow);
    var aiRow = createMessageRow("ai", "");
    document.getElementById("chatHistoryContainer").appendChild(aiRow);
    var thinkingFrames = [".", "..", "...", ".."];
    var thinkingFrameIndex = 0;
    var thinkingTimer = window.setInterval(function () {
        setStreamingMessageText(aiRow, "Thinking" + thinkingFrames[thinkingFrameIndex]);
        thinkingFrameIndex = (thinkingFrameIndex + 1) % thinkingFrames.length;
    }, 300);
    setStreamingMessageText(aiRow, "Thinking.");
    scrollChatToBottom();

    chatHistoryLog.push({ role: "user", content: payload });
    persistWorkspaceSession();
    textInput.value = "";
    setProcessingState(true);
    var streamedReply = "";
    var responseBuffer = "";
    var processedResponseLength = 0;
    var streamError = "";
    var firstTokenReceived = false;
    var streamQueue = "";
    var streamQueueOffset = 0;
    var streamTimer = null;
    var responseComplete = false;
    var responseFinalized = false;
    var responseError = "";

    function processStreamLine(line) {
        if (!line) return;
        var chunk;
        try {
            chunk = JSON.parse(line);
        } catch (error) {
            streamError = "LuK.AI sent an invalid streaming response.";
            return;
        }
        if (chunk.error) {
            streamError = chunk.error;
            return;
        }
        if (chunk.message && typeof chunk.message.content === "string" && chunk.message.content) {
            if (!firstTokenReceived) {
                firstTokenReceived = true;
                window.clearInterval(thinkingTimer);
                setStreamingMessageText(aiRow, "");
            }
            streamedReply += chunk.message.content;
            streamQueue += chunk.message.content;
            drainStreamQueue();
        }
    }

    function drainStreamQueue() {
        var remaining = streamQueue.length - streamQueueOffset;
        if (streamTimer !== null || remaining === 0) {
            if (responseComplete && remaining === 0) finalizeResponse();
            return;
        }
        streamTimer = window.setTimeout(function () {
            var nextLength = Math.min(4, streamQueue.length - streamQueueOffset);
            var nextText = streamQueue.substring(streamQueueOffset, streamQueueOffset + nextLength);
            var lastCode = nextText.charCodeAt(nextText.length - 1);
            var nextCode = streamQueue.charCodeAt(streamQueueOffset + nextLength);
            if (lastCode >= 55296 && lastCode <= 56319 && nextCode >= 56320 && nextCode <= 57343) {
                nextText += streamQueue.charAt(streamQueueOffset + nextLength);
                nextLength++;
            }
            streamQueueOffset += nextLength;
            appendStreamingMessageText(aiRow, nextText);
            scrollChatToBottom();
            if (streamQueueOffset >= streamQueue.length) {
                streamQueue = "";
                streamQueueOffset = 0;
            }
            streamTimer = null;
            drainStreamQueue();
        }, 16);
    }

    function finalizeResponse() {
        if (responseFinalized) return;
        responseFinalized = true;
        window.clearInterval(thinkingTimer);
        if (responseError) {
            chatHistoryLog.pop();
            persistWorkspaceSession(true);
            document.getElementById("chatHistoryContainer").removeChild(userRow);
            document.getElementById("chatHistoryContainer").removeChild(aiRow);
            textInput.value = currentPrompt;
            setEngineStatus(responseError, "error");
        } else {
            setMessageText(aiRow, streamedReply);
            chatHistoryLog.push({ role: "assistant", content: streamedReply });
            persistWorkspaceSession(true);
            if (chatHistoryLog.length === 2 && !sessionTitleRequested) {
                requestSessionTitle(displayText, streamedReply, currentSessionId);
            }
            stagedFilePayload = null;
            renderStagingTray();
            setEngineStatus("LuK.AI is ready.", "connected");
        }
        setProcessingState(false);
        scrollChatToBottom();
        textInput.focus();
    }

    function consumeStream(responseText, isFinal) {
        responseText = responseText || "";
        if (responseText.length > processedResponseLength) {
            responseBuffer += responseText.substring(processedResponseLength);
            processedResponseLength = responseText.length;
        }
        var lines = responseBuffer.split(/\r?\n/);
        responseBuffer = lines.pop();
        var lineIndex;
        for (lineIndex = 0; lineIndex < lines.length; lineIndex++) processStreamLine(lines[lineIndex]);
        if (isFinal && responseBuffer.replace(/\s/g, "")) {
            processStreamLine(responseBuffer);
            responseBuffer = "";
        }
    }

    var systemInstructions = LUKAI_SYSTEM_PROMPT;
    if (developerInstructions) systemInstructions += "\n\nDeveloper instructions:\n" + developerInstructions;
    var crossChatContext = getRelevantChatContext(currentPrompt || (stagedFilePayload ? stagedFilePayload.data.substring(0, 2000) : ""));
    if (crossChatContext) {
        systemInstructions += "\n\nRelevant context from other saved conversations (historical and potentially outdated; use only when helpful):\n" + crossChatContext;
    }
    var requestMessages = [{ role: "system", content: systemInstructions }].concat(chatHistoryLog);
    makeRequest("POST", "http://127.0.0.1:11434/api/chat", JSON.stringify({
        model: activeModel,
        messages: requestMessages,
        stream: true,
        options: getGenerationOptions()
    }), function (xhr, networkError) {
        responseError = networkError;
        consumeStream(xhr.responseText, true);
        if (!responseError) {
            if (xhr.status < 200 || xhr.status >= 300) responseError = streamError || "LuK.AI request failed (HTTP " + xhr.status + ").";
            else if (streamError) responseError = streamError;
            else if (!streamedReply) {
                try {
                    var finalData = JSON.parse(xhr.responseText || "{}");
                    if (finalData.message && typeof finalData.message.content === "string") streamedReply = finalData.message.content;
                    else responseError = finalData.error || "The model returned no response.";
                } catch (parseError) {
                    responseError = "The model returned no response.";
                }
            }
        }
        responseComplete = true;
        drainStreamQueue();
    }, function (responseText) {
        consumeStream(responseText, false);
    });
}

function setProcessingState(isBusy) {
    requestInProgress = isBusy;
    document.getElementById("sendBtn").disabled = isBusy;
    document.getElementById("attachBtn").disabled = isBusy;
    document.getElementById("userInputText").disabled = isBusy;
}

function createMessageRow(role, message) {
    var row = document.createElement("div");
    row.className = "message-row " + role;
    var avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.innerText = role === "user" ? "U" : "AI";
    var content = document.createElement("div");
    content.className = "message-content";
    var sender = document.createElement("div");
    sender.className = "sender-name";
    sender.innerText = role === "user" ? "You" : "LuK.AI";
    var text = document.createElement("div");
    text.className = role === "ai" ? "text-payload assistant-prose" : "text-payload";
    if (role === "ai") renderAssistantContent(text, message);
    else appendInlineFormatting(text, String(message || ""));
    content.appendChild(sender);
    content.appendChild(text);
    row.appendChild(avatar);
    row.appendChild(content);
    return row;
}

function setMessageText(row, message) {
    var text = row.getElementsByTagName("div");
    var i;
    for (i = 0; i < text.length; i++) {
        if ((" " + text[i].className + " ").indexOf(" text-payload ") >= 0) {
            renderAssistantContent(text[i], message);
            return;
        }
    }
}

function setStreamingMessageText(row, message) {
    var text = row.getElementsByTagName("div");
    var i;
    for (i = 0; i < text.length; i++) {
        if ((" " + text[i].className + " ").indexOf(" text-payload ") >= 0) {
            text[i].innerText = message;
            return;
        }
    }
}

function appendStreamingMessageText(row, message) {
    var elements = row.getElementsByTagName("div");
    var i;
    for (i = 0; i < elements.length; i++) {
        if ((" " + elements[i].className + " ").indexOf(" text-payload ") >= 0) {
            elements[i].appendChild(document.createTextNode(message));
            return;
        }
    }
}

function renderAssistantContent(container, message) {
    while (container.firstChild) container.removeChild(container.firstChild);
    var source = String(message || "").replace(/\r\n?/g, "\n");
    var codePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
    var lastIndex = 0;
    var match;
    while ((match = codePattern.exec(source)) !== null) {
        if (match.index > lastIndex) appendFormattedProse(container, source.substring(lastIndex, match.index));
        appendCodeBlock(container, match[1], match[2]);
        lastIndex = codePattern.lastIndex;
    }
    if (lastIndex < source.length) appendFormattedProse(container, source.substring(lastIndex));
    if (!source) container.appendChild(document.createTextNode(""));
}

function appendCodeBlock(container, language, codeText) {
    var block = document.createElement("div");
    block.className = "code-block";
    var label = document.createElement("div");
    label.className = "code-language";
    label.innerText = language.replace(/^\s+|\s+$/g, "") || "Code";
    var pre = document.createElement("pre");
    var code = document.createElement("code");
    code.innerText = codeText.replace(/\n$/, "");
    pre.appendChild(code);
    block.appendChild(label);
    block.appendChild(pre);
    container.appendChild(block);
}

function appendFormattedProse(container, prose) {
    var lines = prose.split("\n");
    var list = null;
    var listType = "";
    var paragraphLines = [];
    var i, line, heading, bullet, numbered;

    function flushParagraph() {
        if (paragraphLines.length === 0) return;
        var paragraph = document.createElement("p");
        appendInlineFormatting(paragraph, paragraphLines.join(" "));
        container.appendChild(paragraph);
        paragraphLines = [];
    }

    function closeList() {
        if (!list) return;
        container.appendChild(list);
        list = null;
        listType = "";
    }

    for (i = 0; i < lines.length; i++) {
        line = lines[i];
        heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
        bullet = line.match(/^\s*[-*+]\s+(.+)$/);
        numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
        if (!line.replace(/\s/g, "")) {
            flushParagraph();
            closeList();
            continue;
        }
        if (heading) {
            flushParagraph();
            closeList();
            var headingElement = document.createElement("h" + heading[1].length);
            appendInlineFormatting(headingElement, heading[2]);
            container.appendChild(headingElement);
            continue;
        }
        if (bullet || numbered) {
            flushParagraph();
            var nextType = bullet ? "ul" : "ol";
            if (!list || listType !== nextType) {
                closeList();
                list = document.createElement(nextType);
                listType = nextType;
            }
            var listItem = document.createElement("li");
            appendInlineFormatting(listItem, (bullet || numbered)[1]);
            list.appendChild(listItem);
            continue;
        }
        closeList();
        paragraphLines.push(line.replace(/^\s+|\s+$/g, ""));
    }
    flushParagraph();
    closeList();
}

function appendInlineFormatting(element, text) {
    var pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|<u>[\s\S]+?<\/u>)/g;
    var lastIndex = 0;
    var match;
    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) element.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
        var token = match[0];
        var formatted;
        if (token.substring(0, 2) === "**") {
            formatted = document.createElement("strong");
            formatted.innerText = token.substring(2, token.length - 2);
        } else if (token.charAt(0) === "*") {
            formatted = document.createElement("em");
            formatted.innerText = token.substring(1, token.length - 1);
        } else if (token.substring(0, 3).toLowerCase() === "<u>") {
            formatted = document.createElement("u");
            formatted.innerText = token.substring(3, token.length - 4);
        } else {
            formatted = document.createElement("code");
            formatted.className = "inline-code";
            formatted.innerText = token.substring(1, token.length - 1);
        }
        element.appendChild(formatted);
        lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) element.appendChild(document.createTextNode(text.substring(lastIndex)));
}

function addAttachmentPill(row, message) {
    var content = row.getElementsByTagName("div")[1];
    var pill = document.createElement("div");
    pill.className = "attachment-pill";
    pill.innerText = message;
    content.appendChild(pill);
}

function addWelcomeMessage(message) {
    document.getElementById("chatHistoryContainer").appendChild(createMessageRow("ai", message));
}

function clearChatHistory() {
    var history = document.getElementById("chatHistoryContainer");
    while (history.firstChild) history.removeChild(history.firstChild);
}

function scrollChatToBottom() {
    var wrapper = document.getElementById("chatScrollWrapper");
    wrapper.scrollTop = wrapper.scrollHeight;
}

function makeSessionId() {
    return String(new Date().getTime()) + "_" + Math.floor(Math.random() * 1000000000).toString(36);
}

function startNewConversationSession() {
    chatHistoryLog = [];
    stagedFilePayload = null;
    currentSessionId = makeSessionId();
    currentSessionTitle = "New conversation";
    currentSessionFilename = "LuK.AI_Conversation_" + currentSessionId + ".luksession";
    currentSessionFolder = "";
    sessionTitleRequested = false;
    clearChatHistory();
    renderStagingTray();
    addWelcomeMessage("Hi! I'm LuK.AI. Start a new conversation whenever you're ready.");
    var input = document.getElementById("userInputText");
    if (input) {
        input.value = "";
        input.focus();
    }
    persistWorkspaceSession(true);
}

function persistWorkspaceSession(refreshHistory) {
    if (!currentSessionId) {
        currentSessionId = makeSessionId();
        currentSessionTitle = currentSessionTitle || "New conversation";
        currentSessionFilename = "LuK.AI_Conversation_" + currentSessionId + ".luksession";
    }
    try {
        var fso = new ActiveXObject("Scripting.FileSystemObject");
        getSessionStoragePath(fso);
        var foldersToTry = [currentSessionFolder, sessionStoragePath, workspacePath];
        var sessionData = {
            version: 2,
            id: currentSessionId,
            title: currentSessionTitle || "New conversation",
            updatedAt: new Date().getTime(),
            messages: chatHistoryLog
        };
        var saveError = null;
        var saved = false;
        var folderIndex;
        var triedFolders = [];
        for (folderIndex = 0; folderIndex < foldersToTry.length && !saved; folderIndex++) {
            var saveFolder = foldersToTry[folderIndex];
            if (!saveFolder || !fso.FolderExists(saveFolder)) continue;
            if (triedFolders.indexOf(saveFolder) >= 0) continue;
            triedFolders.push(saveFolder);
            var textStream = null;
            try {
                var fullPath = fso.BuildPath(saveFolder, currentSessionFilename);
                textStream = fso.CreateTextFile(fullPath, true, true);
                textStream.WriteLine("LUKAI-SESSION-2");
                textStream.WriteLine(JSON.stringify(sessionData));
                textStream.Close();
                sessionStoragePath = saveFolder;
                currentSessionFolder = saveFolder;
                saved = true;
            } catch (writeError) {
                saveError = writeError;
                try { if (textStream) textStream.Close(); } catch (ignoreClose) {}
            }
        }
        if (!saved) throw saveError || new Error("No writable session folder was found.");
        loadPreviousChatsList();
        return true;
    } catch (error) {
        setEngineStatus("Auto-save failed: " + error.message, "error");
        return false;
    }
}

function serializeWorkspaceSession() {
    if (!persistWorkspaceSession(true)) alert("Could not save the conversation. Check the session folder permissions.");
}

function refreshSavedChats() {
    if (!loadPreviousChatsList()) alert("Could not load saved conversations. Check the session folder.");
}

function fallbackSessionTitle(firstPrompt) {
    var words = String(firstPrompt || "New conversation").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").split(" ");
    var title = words.slice(0, 7).join(" ");
    if (title.length > 52) title = title.substring(0, 49).replace(/\s+$/, "") + "...";
    return title || "New conversation";
}

function requestSessionTitle(firstPrompt, firstReply, sessionId) {
    if (!sessionId || sessionTitleRequested) return;
    sessionTitleRequested = true;
    var titlePrompt = "Create a short, easy-to-recognize title of 2 to 6 words for this chat. Reply with only the title, no quotes.\nUser: " +
        String(firstPrompt || "").substring(0, 500) + "\nAssistant: " + String(firstReply || "").substring(0, 500);
    makeRequest("POST", "http://127.0.0.1:11434/api/generate", JSON.stringify({
        model: activeModel,
        prompt: titlePrompt,
        stream: false,
        options: { temperature: 0.2, num_ctx: DEFAULT_CONTEXT_LENGTH, num_predict: 64 }
    }), function (xhr, networkError) {
        if (currentSessionId !== sessionId) return;
        var title = "";
        if (!networkError && xhr.status >= 200 && xhr.status < 300) {
            try {
                var result = JSON.parse(xhr.responseText || "{}");
                title = String(result.response || "").split(/\r?\n/)[0].replace(/^[\s"'`#]+|[\s"'`#]+$/g, "");
                if (title.length > 52) title = title.substring(0, 49).replace(/\s+$/, "") + "...";
            } catch (ignore) {}
        }
        currentSessionTitle = title || fallbackSessionTitle(firstPrompt);
        persistWorkspaceSession(true);
    });
}

function loadPreviousChatsList() {
    var listFrame = document.getElementById("historySectionList");
    var sectionTitle = document.getElementById("historySectionTitle");
    if (!listFrame) return false;
    while (listFrame.firstChild) listFrame.removeChild(listFrame.firstChild);
    var found = false;
    var sessionCount = 0;
    var foldersToScan = [sessionStoragePath, workspacePath];
    var scannedFolders = [];
    var scannedFolderCount = 0;
    var folderIndex;
    var lastError = null;
    try {
        var fso = new ActiveXObject("Scripting.FileSystemObject");
        if (!sessionStoragePath) {
            try { sessionStoragePath = getSessionStoragePath(fso); } catch (storageError) { lastError = storageError; }
            foldersToScan = [sessionStoragePath, workspacePath];
        }
        for (folderIndex = 0; folderIndex < foldersToScan.length; folderIndex++) {
            if (!foldersToScan[folderIndex]) continue;
            if (scannedFolders.indexOf(foldersToScan[folderIndex]) >= 0) continue;
            try {
                var folder = fso.GetFolder(foldersToScan[folderIndex]);
                scannedFolders.push(foldersToScan[folderIndex]);
                scannedFolderCount++;
                var files = new Enumerator(folder.Files);
                for (; !files.atEnd(); files.moveNext()) {
                    var file = files.item();
                    var normalizedName = String(file.Name).toLowerCase();
                    var isLegacySession = normalizedName.indexOf("luk.ai_") === 0 && normalizedName.indexOf("_save_code_") > 0 && normalizedName.slice(-4) === ".txt";
                    var isSessionFile = normalizedName.indexOf("luk.ai_conversation_") === 0 && normalizedName.slice(-11) === ".luksession";
                    if (isLegacySession || isSessionFile) {
                        found = true;
                        sessionCount++;
                        var savedPath = fso.BuildPath(foldersToScan[folderIndex], file.Name);
                        var savedData = null;
                        try { savedData = readSavedSession(savedPath, fso); } catch (ignoreRead) {}
                        var marker = isSessionFile ? "_Conversation_" : "_Save_code_";
                        var markerIndex = file.Name.indexOf(marker);
                        var extensionLength = isSessionFile ? 11 : 4;
                        var fallbackTitle = isLegacySession ? "Saved conversation" : "New conversation";
                        var displayTitle = savedData && savedData.title ? savedData.title : fallbackTitle;
                        (function (savedName, savedFolder, title) {
                            var entry = document.createElement("div");
                            entry.className = "history-entry";
                            var openButton = document.createElement("button");
                            openButton.type = "button";
                            openButton.className = "history-item";
                            openButton.title = title;
                            openButton.innerText = title;
                            openButton.onclick = function () { restoreTargetSession(savedName, savedFolder); };
                            var deleteButton = document.createElement("button");
                            deleteButton.type = "button";
                            deleteButton.className = "history-delete";
                            deleteButton.title = "Delete saved conversation";
                            deleteButton.setAttribute("aria-label", "Delete " + title);
                            deleteButton.innerText = "×";
                            deleteButton.onclick = function () { deleteSavedSession(savedName, savedFolder); };
                            entry.appendChild(openButton);
                            entry.appendChild(deleteButton);
                            listFrame.appendChild(entry);
                        })(file.Name, foldersToScan[folderIndex], displayTitle || file.Name.substring(markerIndex + marker.length, file.Name.length - extensionLength));
                    }
                }
            } catch (folderError) {
                lastError = folderError;
            }
        }
        if (!found) {
            if (scannedFolderCount === 0 && lastError) throw lastError;
            var empty = document.createElement("div");
            empty.className = "empty-history";
            empty.innerText = "Your saved conversations will appear here.";
            listFrame.appendChild(empty);
        }
        if (sectionTitle) sectionTitle.innerText = "Recent sessions (" + sessionCount + ")";
        return true;
    } catch (error) {
        listFrame.innerText = "Session folder unavailable: " + error.message;
        if (sectionTitle) sectionTitle.innerText = "Recent sessions (unavailable)";
        setEngineStatus("Cannot load saved sessions: " + error.message, "error");
        return false;
    }
}

function readSavedSession(fullPath, fso) {
    fso = fso || new ActiveXObject("Scripting.FileSystemObject");
    var formats = [-1, 0];
    var lastError = null;
    var formatIndex;
    for (formatIndex = 0; formatIndex < formats.length; formatIndex++) {
        var stream = null;
        try {
            stream = fso.OpenTextFile(fullPath, 1, false, formats[formatIndex]);
            stream.ReadLine();
            var dataLine = stream.ReadAll();
            stream.Close();
            var loaded = JSON.parse(dataLine);
            if (loaded instanceof Array) return { id: "", title: "", messages: loaded };
            if (loaded && loaded.messages instanceof Array) return loaded;
            throw new Error("Session data is not a message list.");
        } catch (error) {
            lastError = error;
            try { if (stream) stream.Close(); } catch (ignoreClose) {}
        }
    }
    throw lastError || new Error("Session file could not be decoded.");
}

function extractChatContextTerms(text) {
    var words = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/);
    var ignored = " about after again also and any are because been before being between both but can could did does doing down each few for from had has have here how into its just like more most not now off once only other our out over same should some such than that the their them then there these they this those through too under until very was were what when where which while who why will with would you your";
    var terms = [];
    var i, word;
    for (i = 0; i < words.length && terms.length < 24; i++) {
        word = words[i];
        if (word.length < 3 || ignored.indexOf(" " + word + " ") >= 0 || terms.indexOf(word) >= 0) continue;
        terms.push(word);
    }
    return terms;
}

function scoreChatContext(text, queryTerms) {
    var normalized = " " + String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
    var score = 0;
    var i;
    for (i = 0; i < queryTerms.length; i++) {
        if (normalized.indexOf(" " + queryTerms[i] + " ") >= 0) score++;
    }
    return score;
}

function getRelevantChatContext(query) {
    var queryTerms = extractChatContextTerms(query);
    if (!queryTerms.length) return "";
    var fso;
    try { fso = new ActiveXObject("Scripting.FileSystemObject"); } catch (ignoreFileSystem) { return ""; }
    if (!sessionStoragePath) {
        try { sessionStoragePath = getSessionStoragePath(fso); } catch (ignoreStoragePath) {}
    }
    var folders = [sessionStoragePath, workspacePath];
    var seenFolders = [];
    var candidates = [];
    var folderIndex, files, file, filename, savedSession, messages, messageIndex, userText, assistantText, score, candidateKey;
    for (folderIndex = 0; folderIndex < folders.length; folderIndex++) {
        if (!folders[folderIndex] || seenFolders.indexOf(folders[folderIndex]) >= 0) continue;
        seenFolders.push(folders[folderIndex]);
        try {
            files = new Enumerator(fso.GetFolder(folders[folderIndex]).Files);
            for (; !files.atEnd(); files.moveNext()) {
                file = files.item();
                filename = String(file.Name);
                if (filename.toLowerCase() === String(currentSessionFilename || "").toLowerCase()) continue;
                if (!(/^LuK\.AI_Conversation_.*\.luksession$/i.test(filename) || /^LuK\.AI_.*_Save_code_.*\.txt$/i.test(filename))) continue;
                try {
                    savedSession = readSavedSession(fso.BuildPath(folders[folderIndex], filename), fso);
                    if (savedSession.id && savedSession.id === currentSessionId) continue;
                    messages = savedSession.messages || [];
                    for (messageIndex = 0; messageIndex < messages.length; messageIndex++) {
                        if (!messages[messageIndex] || messages[messageIndex].role !== "user") continue;
                        userText = String(messages[messageIndex].content || "").split("\n\n[Attached document:")[0].substring(0, 1200);
                        assistantText = messageIndex + 1 < messages.length && messages[messageIndex + 1].role === "assistant" ? String(messages[messageIndex + 1].content || "").substring(0, 1600) : "";
                        score = scoreChatContext(userText + " " + assistantText, queryTerms);
                        if (score < (queryTerms.length < 4 ? 1 : 2)) continue;
                        candidateKey = savedSession.id || filename.toLowerCase();
                        candidates.push({
                            key: candidateKey,
                            title: String(savedSession.title || "Previous conversation"),
                            userText: userText,
                            assistantText: assistantText,
                            score: score,
                            updatedAt: Number(savedSession.updatedAt || 0)
                        });
                    }
                } catch (ignoreSession) {}
            }
        } catch (ignoreFolder) {}
    }
    candidates.sort(function (left, right) {
        if (right.score !== left.score) return right.score - left.score;
        return right.updatedAt - left.updatedAt;
    });
    var selected = [];
    var selectedKeys = [];
    var context = "";
    var i, entry, excerpt;
    for (i = 0; i < candidates.length && selected.length < MAX_CROSS_CHAT_CONTEXTS; i++) {
        entry = candidates[i];
        if (selectedKeys.indexOf(entry.key) >= 0) continue;
        excerpt = "Chat: " + entry.title + "\nUser: " + entry.userText;
        if (entry.assistantText) excerpt += "\nLuK.AI: " + entry.assistantText;
        if (context.length + excerpt.length > 4200) excerpt = excerpt.substring(0, Math.max(0, 4200 - context.length));
        if (!excerpt) break;
        selected.push(entry);
        selectedKeys.push(entry.key);
        context += (context ? "\n\n" : "") + excerpt;
        if (context.length >= 4200) break;
    }
    return context;
}

function deleteSavedSession(filename, sourceFolder) {
    if (!window.confirm("Delete this saved conversation? This cannot be undone.")) return;
    try {
        var fso = new ActiveXObject("Scripting.FileSystemObject");
        var fullPath = fso.BuildPath(sourceFolder || sessionStoragePath || workspacePath, filename);
        if (!fso.FileExists(fullPath)) throw new Error("The saved conversation was not found.");
        fso.DeleteFile(fullPath, true);
        if (filename === currentSessionFilename && sourceFolder === currentSessionFolder) {
            startNewConversationSession();
        } else {
            loadPreviousChatsList();
        }
    } catch (error) {
        alert("Could not delete the saved conversation. " + error.message);
    }
}

function restoreTargetSession(filename, sourceFolder) {
    if (requestInProgress) return;
    try {
        var fso = new ActiveXObject("Scripting.FileSystemObject");
        var fullPath = fso.BuildPath(sourceFolder || sessionStoragePath || workspacePath, filename);
        if (!fso.FileExists(fullPath)) throw new Error("Session not found.");
        var savedSession = readSavedSession(fullPath, fso);
        chatHistoryLog = savedSession.messages;
        currentSessionId = savedSession.id || filename.replace(/^LuK\.AI_/, "").replace(/\.(luksession|txt)$/i, "");
        currentSessionTitle = savedSession.title || "Saved conversation";
        currentSessionFilename = filename;
        currentSessionFolder = sourceFolder || sessionStoragePath || workspacePath;
        sessionTitleRequested = !!savedSession.title;
        clearChatHistory();
        var i, message, cleanText, row;
        for (i = 0; i < chatHistoryLog.length; i++) {
            message = chatHistoryLog[i];
            if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
            cleanText = String(message.content || "");
            if (message.role === "user" && cleanText.indexOf("\n\n[Attached document:") >= 0) {
                cleanText = cleanText.substring(0, cleanText.indexOf("\n\n[Attached document:"));
            }
            row = createMessageRow(message.role === "user" ? "user" : "ai", cleanText);
            document.getElementById("chatHistoryContainer").appendChild(row);
        }
        scrollChatToBottom();
        if (!sessionTitleRequested && chatHistoryLog.length > 0) {
            var firstUserMessage = "";
            var firstAssistantReply = "";
            for (i = 0; i < chatHistoryLog.length; i++) {
                if (!firstUserMessage && chatHistoryLog[i].role === "user") firstUserMessage = chatHistoryLog[i].content;
                if (firstUserMessage && chatHistoryLog[i].role === "assistant") {
                    firstAssistantReply = chatHistoryLog[i].content;
                    break;
                }
            }
            if (firstUserMessage) requestSessionTitle(firstUserMessage, firstAssistantReply, currentSessionId);
        }
    } catch (error) {
        alert("Could not open that saved conversation.");
    }
}
