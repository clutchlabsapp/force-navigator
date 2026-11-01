import { forceNavigator, _d, sfObjectsGetData } from "./shared"
import { t } from "lisan"

// Chrome stops idle MV3 service workers, which wipes module-level variables.
// Keep caches in chrome.storage.session (cleared when the browser closes, like
// the old persistent background page) and mirror them in memory for speed.
const cache = {
	"memory": {},
	"get": async (key)=>{
		if(cache.memory[key] !== undefined)
			return cache.memory[key]
		try {
			const stored = await chrome.storage.session.get(key)
			cache.memory[key] = stored[key]
		} catch(e) { _d([e]) }
		return cache.memory[key]
	},
	"set": async (key, value)=>{
		cache.memory[key] = value
		try { await chrome.storage.session.set({[key]: value}) }
		catch(e) { console.warn("Could not persist " + key + "; keeping it in memory only", e) }
	}
}
const metaDataKey = (sessionHash)=>"metaData." + sessionHash
const historyKey = (orgId)=>"commandsHistory." + orgId
const MAX_HISTORY = 8

const apiHeaders = (sessionId, contentType = false)=>Object.assign(
	{"Authorization": "Bearer " + sessionId, "Accept": "application/json"},
	contentType ? {"Content-Type": "application/json"} : {}
)
const apiBase = (request)=>"https://" + request.apiUrl + "/services/data/" + forceNavigator.apiVersion
const sendError = (sendResponse, e)=>{
	_d([e])
	sendResponse({"error": e?.message ?? String(e)})
}

const showElement = (element)=>{
	chrome.tabs.query({currentWindow: true, active: true}, (tabs)=>{
		if(!tabs[0]) return
		switch(element) {
			case "appMenu":
				chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: ()=>{
					document.getElementsByClassName("appLauncher")[0]?.getElementsByTagName("button")[0]?.click()
				}})
				break
			case "searchBox":
				chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: ()=>{
					if(document.getElementById("sfnavSearchBox")) {
						document.getElementById("sfnavSearchBox").style.zIndex = 9999
						document.getElementById("sfnavSearchBox").style.opacity = 0.98
						document.getElementById("sfnavQuickSearch").focus()
					}
				}})
				break
		}
	})
}

const getOtherExtensionCommands = (otherExtension, requestDetails, sendResponse)=>{
	const url = requestDetails.domain.replace(/https*:\/\//, '')
	const apiUrl = requestDetails.apiUrl
	let commands = {}
	if(!chrome.management) { sendResponse(commands); return }
	chrome.management.get(otherExtension.id, response => {
		if(chrome.runtime.lastError) { sendResponse(commands); return }
		otherExtension.commands.forEach(c=>{
			commands[c.key] = {
				"url": otherExtension.platform + "://" + otherExtension.urlId + c.url.replace("$URL",url).replace("$APIURL",apiUrl),
				"label": t(c.key),
				"key": c.key
			}
		})
		sendResponse(commands)
	})
}

const parseMetadata = (data, serverUrl)=>{
	if (data.length == 0 || typeof data.sobjects == "undefined") return false
	return data.sobjects.reduce((commands, sObjectData) => forceNavigator.createSObjectCommands(commands, sObjectData, serverUrl), {})
}

// Navigate the tab that sent the message (or the active tab for keyboard shortcuts)
const goToUrl = (targetUrl, newTab, tab)=>{
	const navigate = (tab)=>{
		if(!tab) return
		const re = new RegExp("\\w+-extension:\/\/"+chrome.runtime.id,"g")
		targetUrl = targetUrl.replace(re,'')
		let newUrl
		if(targetUrl.includes('-extension:'))
			newUrl = targetUrl
		else {
			const path = targetUrl.match(/.*?\.com(.*)/)
			newUrl = tab.url.match(/.*?\.com/)[0] + (path ? path[1] : targetUrl)
		}
		if(newTab)
			chrome.tabs.create({ "active": false, "url": newUrl, "index": tab.index + 1 })
		else
			chrome.tabs.update(tab.id, { "url": newUrl })
	}
	if(tab) navigate(tab)
	else chrome.tabs.query({currentWindow: true, active: true}, tabs=>navigate(tabs[0]))
}

// The API needs the session cookie from the My Domain host, not the Lightning host
const getApiSessionId = (request, sender, sendResponse)=>{
	const apiHost = request.serverUrl?.replace('lightning.force.com','my.salesforce.com')
	const cookieQuery = {url: apiHost, name: "sid"}
	if(sender.tab?.cookieStoreId) cookieQuery.storeId = sender.tab.cookieStoreId // Firefox containers
	chrome.cookies.get(cookieQuery, c=>{
		if(!c) {
			sendResponse({error: "No session data found for " + request.serverUrl})
			return
		}
		const sid = c.value
		const orgId = sid.match(/([\w\d]+)/)[1]
		forceNavigator.getHTTP("https://" + c.domain + "/services/data/" + forceNavigator.apiVersion, "json", apiHeaders(sid))
		.then(response=>{
			if(response?.identity)
				sendResponse({sessionId: sid, userId: response.identity.match(/005.*/)[0], orgId: orgId, apiUrl: c.domain})
			else
				sendResponse({error: "No user data found for " + orgId})
		}).catch(e=>sendError(sendResponse, e))
	})
}

const getMetadata = async (request, sendResponse)=>{
	const key = metaDataKey(request.sessionHash)
	let commands = request.force ? null : await cache.get(key)
	if(!commands) {
		const response = await forceNavigator.getHTTP(apiBase(request) + "/sobjects/", "json", apiHeaders(request.sessionId))
		commands = parseMetadata(response, request.serverUrl)
		await cache.set(key, commands)
	}
	sendResponse(commands)
}

const getActiveFlows = async (request, sendResponse)=>{
	const response = await forceNavigator.getHTTP(apiBase(request) + "/query/?q=select+ActiveVersionId,Label+from+FlowDefinitionView+where+IsActive=true", "json", apiHeaders(request.sessionId))
	const targetUrl = request.domain + "/builder_platform_interaction/flowBuilder.app?flowId="
	let flowCommands = {}
	response.records?.forEach(f=>{
		flowCommands["flow." + f.ActiveVersionId] = {
			"key": "flow." + f.ActiveVersionId,
			"url": targetUrl + f.ActiveVersionId,
			"label": [t("prefix.flows"), f.Label].join(" > ")
		}
	})
	sendResponse(flowCommands)
}

/*
Map each object label to its API name and its "name" field, used by "? <object> <terms>" search.
	Product2  Product  Name
	Problem   Problem  ProblemNumber
*/
const getSobjectNameFields = async (request, sendResponse)=>{
	const q = encodeURI("select QualifiedApiName, EntityDefinition.QualifiedApiName,EntityDefinition.MasterLabel from FieldDefinition where (EntityDefinition.QualifiedApiName like '%') and IsNameField = true")
	const response = await forceNavigator.getHTTP(apiBase(request) + "/query/?q=" + q, "json", apiHeaders(request.sessionId))
	let labelToSobjectApiNameMapping = {}
	let labelToNameFieldMapping = {}
	response.records?.forEach(f=>{
		const apiName = f.EntityDefinition.QualifiedApiName
		let objectLabel = f.EntityDefinition.MasterLabel.toLowerCase()
		if(labelToSobjectApiNameMapping[objectLabel]) {
			// Duplicate label (e.g. Calendar and CalendarView); add the API name to tell them apart
			objectLabel = objectLabel + "(" + apiName + ")"
		}
		objectLabel = objectLabel.replace(/['\"]/g, "")
		labelToSobjectApiNameMapping[objectLabel] = apiName
		labelToNameFieldMapping[objectLabel] = f.QualifiedApiName
	})
	sendResponse({"labelToNameFieldMapping": labelToNameFieldMapping, "labelToSobjectApiNameMapping": labelToSobjectApiNameMapping})
}

// Load an object's compact layout; its fields are shown in "?" search results
const loadCompactLayoutForSobject = async (request, sendResponse)=>{
	const response = await forceNavigator.getHTTP(apiBase(request) + "/compactLayouts?q=" + encodeURI(request.sobject), "json", apiHeaders(request.sessionId))
	if(response?.error || Array.isArray(response)) { sendResponse({"error": JSON.stringify(response)}); return }
	let mainFields = []
	Object.values(response).forEach(layout=>layout.fieldItems?.forEach(f=>{
		const name = f.layoutComponents?.[0]?.details?.name
		if(name) mainFields.push(name)
	}))
	sendResponse({"mainFields": mainFields.join(",")})
}

// "? <object> <terms>" record search via SOSL
const doSearch = async (request, sendResponse)=>{
	const { labelToNameFieldMapping = {}, labelToSobjectApiNameMapping = {}, compactLayoutFieldsForSobject = {} } = request
	const searchQuery = request.searchQuery.replace(/^\?\s*/,'')
	let searchQueryArray = searchQuery.split(/([^\s"]+|"[^"]*")+/g).filter(value => (value != ' ' && value != ''))
	const searchSobject = (searchQueryArray.shift() ?? "").replaceAll('"','')
	const lc_searchSobject = searchSobject.toLowerCase()
	let searchText = searchQueryArray.join(" ").trim()
	if(searchText.startsWith('"') && searchText.endsWith('"'))
		searchText = searchText.slice(1, -1)
	// escape SOSL reserved characters
	searchText = searchText.replace(/[?&|!{}\[\]()^~*:\\"'+\-]/g, '\\$&')
	const nameField = labelToNameFieldMapping[lc_searchSobject]
	const objectApiName = labelToSobjectApiNameMapping[lc_searchSobject]
	if(!nameField || !objectApiName) {
		sendResponse({"error": "can't find object " + lc_searchSobject})
		return
	}
	const layoutFields = compactLayoutFieldsForSobject[objectApiName.toLowerCase()] ?? compactLayoutFieldsForSobject[lc_searchSobject]
	const fieldsToReturn = `(Id,${layoutFields || nameField})`
	const sosl = `FIND {${searchText}} IN NAME FIELDS RETURNING ${objectApiName} ${fieldsToReturn} LIMIT 7`
	const response = await forceNavigator.getHTTP(apiBase(request) + "/search/?q=" + encodeURIComponent(sosl), "json", apiHeaders(request.sessionId))
	if(!response?.searchRecords) { sendResponse({"error": JSON.stringify(response)}); return }
	sendResponse({
		"searchRecords": response.searchRecords,
		"searchObject": lc_searchSobject,
		"objectApiName": objectApiName,
		"mainFields": layoutFields
	})
}

// Tab-expand a command, e.g. "Account > Fields" lists every Account field
const getMoreData = async (request, sendResponse)=>{
	const sourceCommand = request.sourceCommand
	const infoToGet = sourceCommand.key.split('.').pop()
	if(sourceCommand.detailsAlreadyLoaded) {
		sendResponse({"info": "already loaded data for " + infoToGet})
		return
	}
	if(typeof sfObjectsGetData[infoToGet] == "undefined") {
		sendResponse({"info": "can't expand " + infoToGet})
		return
	}
	const url = apiBase(request) + sfObjectsGetData[infoToGet].getDataRequest(sourceCommand.apiname)
	const response = await forceNavigator.getHTTP(url, "json", apiHeaders(request.sessionId))
	if(response?.error || Array.isArray(response)) { sendResponse({"error": JSON.stringify(response)}); return }
	const objCommands = sfObjectsGetData[infoToGet].processResponse(sourceCommand.apiname, sourceCommand.label, response)
	const key = metaDataKey(request.sessionHash)
	const commands = await cache.get(key)
	if(commands) await cache.set(key, Object.assign(commands, objCommands))
	sendResponse(objCommands)
}

const createTask = async (request, sendResponse)=>{
	const response = await forceNavigator.getHTTP(apiBase(request) + "/sobjects/Task", "json",
		apiHeaders(request.sessionId, true), {"Subject": request.subject, "OwnerId": request.userId}, "POST")
	sendResponse(response)
}

const searchLogins = async (request, sendResponse)=>{
	const term = encodeURIComponent(request.searchValue.trim().replace(/'/g, "\\'"))
	const response = await forceNavigator.getHTTP(apiBase(request) + "/query/?q=SELECT+Id,+Name,+Username+FROM+User+WHERE+Name+LIKE+'%25" + term + "%25'+OR+Username+LIKE+'%25" + term + "%25'", "json", apiHeaders(request.sessionId, true))
	sendResponse(response)
}

const updateLastCommand = async (request)=>{
	if(!request.key || !request.url) return
	const key = historyKey(request.orgId)
	let history = (await cache.get(key) ?? []).filter(c=>c[0] != request.key)
	history.push([request.key, request.url])
	await cache.set(key, history.slice(-MAX_HISTORY))
}

const getCommandsHistory = async (request, sendResponse)=>{
	sendResponse({"commandsHistory": await cache.get(historyKey(request.orgId)) ?? []})
}

chrome.commands.onCommand.addListener((command)=>{
	switch(command) {
		case 'showSearchBox': showElement("searchBox"); break
		case 'showAppMenu': showElement("appMenu"); break
		case 'goToTasks': goToUrl(".com/00T"); break
		case 'goToReports': goToUrl(".com/00O"); break
	}
})

// Handlers that answer asynchronously: (request, sendResponse, sender). Each one must call sendResponse exactly once.
const asyncHandlers = {
	"getApiSessionId": (request, sendResponse, sender)=>getApiSessionId(request, sender, sendResponse),
	"getOtherExtensionCommands": (request, sendResponse)=>getOtherExtensionCommands(request.otherExtension, request, sendResponse),
	"getMetadata": getMetadata,
	"getActiveFlows": getActiveFlows,
	"getSobjectNameFields": getSobjectNameFields,
	"loadCompactLayoutForSobject": loadCompactLayoutForSobject,
	"doSearch": doSearch,
	"getMoreData": getMoreData,
	"createTask": createTask,
	"searchLogins": searchLogins,
	"getCommandsHistory": getCommandsHistory,
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse)=>{
	switch(request.action) {
		case "goToUrl":
			goToUrl(request.url, request.newTab, sender.tab)
			return false
		case "help":
			chrome.tabs.create({url: chrome.runtime.getURL("popup.html")})
			return false
		case "updateLastCommand":
			updateLastCommand(request).catch(e=>_d([e]))
			return false
	}
	const handler = asyncHandlers[request.action]
	if(!handler) return false
	Promise.resolve()
		.then(()=>handler(request, sendResponse, sender))
		.catch(e=>sendError(sendResponse, e))
	return true
})
