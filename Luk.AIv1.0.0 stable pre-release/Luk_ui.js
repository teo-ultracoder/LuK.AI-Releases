// =====================================================================
// LUK.AI - INTERFACE HELPERS (IE/HTA compatible)
// =====================================================================

function renderStagingTray() {
    var tray = document.getElementById("stagingTray");
    while (tray.firstChild) tray.removeChild(tray.firstChild);
    if (!stagedFilePayload) {
        tray.style.display = "none";
        return;
    }

    var item = document.createElement("span");
    item.className = "staged-item";
    item.appendChild(document.createTextNode("Document: " + stagedFilePayload.name + " "));
    var remove = document.createElement("span");
    remove.className = "remove-stage-btn";
    remove.innerText = "×";
    remove.title = "Remove attachment";
    remove.onclick = function () { removeStagedElement("file"); };
    item.appendChild(remove);
    tray.appendChild(item);
    tray.style.display = "block";
}

function removeStagedElement(type) {
    if (type === "file") stagedFilePayload = null;
    renderStagingTray();
}

function catchInputEnter(event) {
    event = event || window.event;
    if ((event.keyCode === 13 || event.which === 13) && !event.shiftKey) {
        if (event.preventDefault) event.preventDefault();
        event.returnValue = false;
        processingPromptQueue();
        return false;
    }
    return true;
}

function showComposerFormattingToolbar() {
    var toolbar = document.getElementById("formatToolbar");
    if (toolbar) toolbar.className = "format-toolbar visible";
}

function scheduleComposerToolbarHide() {
    window.setTimeout(hideComposerFormattingToolbar, 120);
}

function hideComposerFormattingToolbar() {
    var toolbar = document.getElementById("formatToolbar");
    if (!toolbar) return;
    var activeElement = document.activeElement;
    var input = document.getElementById("userInputText");
    if (activeElement === input || (toolbar.contains && toolbar.contains(activeElement))) return;
    toolbar.className = "format-toolbar";
}

function preserveComposerSelection(event) {
    event = event || window.event;
    if (event.preventDefault) event.preventDefault();
    event.returnValue = false;
    return false;
}

function applyComposerFormat(format) {
    var input = document.getElementById("userInputText");
    var formats = {
        bold: { prefix: "**", suffix: "**" },
        italic: { prefix: "*", suffix: "*" },
        underline: { prefix: "<u>", suffix: "</u>" }
    };
    var markers = formats[format];
    if (!input || !markers) return;

    var start = input.selectionStart;
    var end = input.selectionEnd;
    var value = input.value;
    var selected = value.substring(start, end);
    var before = value.substring(Math.max(0, start - markers.prefix.length), start);
    var after = value.substring(end, end + markers.suffix.length);
    var nextStart;
    var nextEnd;

    if (selected && before === markers.prefix && after === markers.suffix) {
        input.value = value.substring(0, start - markers.prefix.length) + selected + value.substring(end + markers.suffix.length);
        nextStart = start - markers.prefix.length;
        nextEnd = end - markers.prefix.length;
    } else {
        input.value = value.substring(0, start) + markers.prefix + selected + markers.suffix + value.substring(end);
        nextStart = start + markers.prefix.length;
        nextEnd = nextStart + selected.length;
    }

    input.focus();
    if (input.setSelectionRange) input.setSelectionRange(nextStart, nextEnd);
    showComposerFormattingToolbar();
}

function initNewSessionWindow() {
    if (requestInProgress) return;
    startNewConversationSession();
}
