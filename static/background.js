import { storage, emitter, openByIframeAndWaitForClose, TIMEOUT_ERROR, notifications, openByIframe, waitEventWithPromise, IFRAME_LIFETIME, updateNotificationPermission } from './utils'
import { addActivityItems, updateActivityItemsStatus, addSuccessActivityList, getActivityItems } from './db'
import { settingConfig, USER_STATUS, ACTIVITY_STATUS } from './config'
import { updateTaskInfo, defaultTasks, getAllTasks } from './tasks'
import { DateTime } from 'luxon'


window.runtime = {
	taskId: -1,
	doneTask: 0,
	totalTask: 0,
	applyingActivityIds: [],
}
window.loginStatus = {
	status: USER_STATUS.UNKNOWN,
	description: '正在获取登录状态',
	shortDescription: '正在检查',
	timestamp: 0,
}
window.saveinfo = {
	followVenderNum: -1,
	applidActivityNum: 0, //per day
	fulfilled: false,
	day: DateTime.local().day
}
function savePersistentData() {
	// storage.set({ loginStatus: loginStatus })  //当浏览器关闭时，cookies 可能会失效，不再保存loginStatus
	storage.set({ saveinfo: saveinfo })
}
window.reset = function () {
	console.log('reset now')
	chrome.storage.local.clear()
	storage.set({ settings: settingConfig })
	for (let task of defaultTasks) {
		updateTaskInfo(task)
	}
}
chrome.runtime.onInstalled.addListener(function (object) {
	reset()
})
chrome.alarms.onAlarm.addListener(function (alarm) {
	switch (true) {
		case alarm.name === 'daily':
			checkAndResetDailyInfo()
			savePersistentData()
			break
		case alarm.name.startsWith('scheduled_'):
			const when = alarm.name.split('_')[1]
			autoRun(when)
			break
		default:
			console.warn(`unknown alarm:${alarm.name}`)
	}
})

chrome.notifications.onClicked.addListener(function (notificationId) {
	if (!notificationId || notificationId.split('_').length < 0) {
		return
	}
	const action = notificationId.split('_')[1]
	switch (action) {
		case 'login-fail':
			chrome.tabs.create({
				url: "https://passport.jd.com/new/login.aspx",
				active: true
			})
			break
		default:
			console.warn(`unknown notificationId:${notificationId}`)
	}
})

// 消息处理

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
	switch (msg.action) {

		//from content-script
		case 'bg_update_saveinfo':
			saveinfo = Object.assign(saveinfo, msg.data)  //should check key?
			// if (saveinfo.fulfilled) {
			// 	saveinfo.applidActivityNum = 300
			// }
			return
		case 'bg_activity_applied':
			if (msg.status) {
				updateActivityItemsStatus(msg.activityId)
			}
			if (msg.success) {
				saveinfo.applidActivityNum++
			}
			emitter.emit(`${msg.activityId}_activity_applied_event`)
			chrome.runtime.sendMessage({
				action: "popup_update_activity_status",
				activityId: msg.activityId,
				status: msg.status
			})
			break
		case 'bg_login_status_retrieval':
			loginStatus = Object.assign(loginStatus, msg.loginStatus)
			emitter.emit('login_status_retrieval_event', { login: msg.status })
			updateBrowserAction()
			break

		case 'bg_new_activity_retrieval':
			if (msg.activityList.length) {
				addActivityItems(msg.activityList)
			}
			emitter.emit(msg.href + '_new_activity_retrieval_event')
			break
		case 'bg_page_num_retrieval':
			emitter.emit(msg.href + '_pages_retrieval_event', { pageNum: msg.pageNum })
			break

		case 'success_activity_retrieval':
			if (msg.successActivityList.length !== 0) {
				addSuccessActivityList(msg.successActivityList)
			}
			emitter.emit(msg.href + '_success_activity_retrieval_event')
			break
		case 'bg_follow_vender_num_retrieval':
			saveinfo.followVenderNum = msg.followVenderNum
			emitter.emit('bg_follow_vender_num_retrieval_event')

			if (runtime.taskId === 1) { //清空关注列表
				runtime.doneTask = runtime.totalTask - saveinfo.followVenderNum
				if (saveinfo.followVenderNum === 0) {
					emitter.emit('empty_follow_vender_list_event')
				}
			}
			break
		case 'bg_get_login_status':
			sendResponse(loginStatus)
			break

		//from popup.html
		//
		case 'bg_scheduled_task':
			initScheduledTasks()
			break

		default:
			console.log(`recevie unkonwn action:${msg.action}`)
			break
	}
})

window.successActivityRetrieval = async function () {
	runtime.doneTask = 1
	runtime.totalTask = 100

	const login = await checkLoginStatusValid()
	if (!login) {
		taskDone()
		return
	}

	console.log(`正在获取试用成功列表`)
	let url = `https://try.jd.com/user/myTrial?page=1&selected=2`
	let pageNum = await pageNumberRetrieval(url)
	console.log(`试用成功列表 一共 ${pageNum} 页`)
	runtime.totalTask = pageNum ? pageNum : 1

	for (let i = 2; i <= pageNum; i++) {
		runtime.doneTask++
		url = `https://try.jd.com/user/myTrial?page=${i}&selected=2`
		const eventName = `${url}_success_activity_retrieval_event`
		await openByIframeAndWaitForClose(url, eventName)
	}

	taskDone()
	notifications('成功项目的检索完毕')
}


window.activityRetrieval = async function () {
	runtime.doneTask = 0
	runtime.totalTask = 100

	//实际上，商品检索并不需要登录
	//所以这里不检查登录状态

	let settings = {}

	await storage.get({ 'settings': [] }).then(res => { settings = res.settings })
	let cidsList = []
	let activityTypeList = []

	for (let activityBtn of settings[0].btns) { //  商品类型
		if (activityBtn.selected) {
			console.log(`即将搜索 ${activityBtn.text} 商品`)
			cidsList.push(activityBtn.value)
		}
	}
	for (let applyBtn of settings[1].btns) { // 试用类型
		if (applyBtn.selected) {
			console.log(`即将搜索 ${applyBtn.text} 试用类型`)
			activityTypeList.push(applyBtn.value)
		}
	}

	if (!cidsList.length) {
		cidsList.push(null)
	}
	if (!activityTypeList.length) {
		activityTypeList.push(null)
	}
	runtime.totalTask = cidsList.length * activityTypeList.length

	for (let cids of cidsList) {
		for (let activityType of activityTypeList) {
			runtime.doneTask++
			await activityRetrievalByCondition(cids, activityType)
		}
	}
	taskDone()
	console.log('本次搜索完毕')
	notifications('搜索并导入数据库完毕')
}


async function activityRetrievalByCondition(cids, activityType) {
	console.log(`正在获取 cids:${cids} activityType:${activityType} 类型商品`)
	let url = `https://try.jd.com/activity/getActivityList?page=1${cids ? '&cids=' + cids : ''}${activityType ? '&activityType=' + activityType : ''}`
	let pageNum = await pageNumberRetrieval(url)
	console.log(`cids:${cids} activityType:${activityType} 一共 ${pageNum} 页`)

	for (let i = 2; i <= pageNum; i++) {
		url = `https://try.jd.com/activity/getActivityList?page=${i}${cids ? '&cids=' + cids : ''}${activityType ? '&activityType=' + activityType : ''}`
		const eventName = `${url}_new_activity_retrieval_event`
		await openByIframeAndWaitForClose(url, eventName)
	}
	return true
}
window.activityApply = async function (activity) {

	runtime.doneTask = 0
	runtime.totalTask = activity.length ? activity.length : 1

	const login = await checkLoginStatusValid()
	if (!login) {
		taskDone()
		return
	}
	console.log(`即将申请 ${activity.length} 个商品`)

	runtime.applyingActivityIds.length = 0
	for (const item of activity) {
		runtime.applyingActivityIds.push(
			item.id
		)
	}

	for (const item of activity) {

		runtime.doneTask++
		if (saveinfo.fulfilled) {
			console.warn('今日申请试用份额已满，不再进行试用申请')
			notifications('今日申请试用份额已满，不再进行试用申请')
			break
		}

		const eventName = `${item.id}_activity_applied_event`

		await openByIframeAndWaitForClose(item.url, eventName)
		runtime.applyingActivityIds.shift()

	}

	taskDone()
	runtime.applyingActivityIds.length = 0

	console.log('商品试用执行完毕')
	notifications('商品试用执行完毕')
	followVenderNumberRetrieval()
}

async function pageNumberRetrieval(url) {
	const eventName = `${url}_pages_retrieval_event`
	const result = await openByIframeAndWaitForClose(url, eventName)
	return result === TIMEOUT_ERROR ? 0 : result.pageNum
}

window.loginStatusRetrieval = async function (retry = 0) {
	if (retry >= 2) { // 最多重试两次
		loginStatus.description = '请检查网络状态'
		loginStatus.shortDescription = '检查超时'
		loginStatus.status = USER_STATUS.UNKNOWN
		loginStatus.timestamp = DateTime.local().valueOf()
		notifications('检查登录状态失败，请检查网络状态后重试', 'login-fail', true)
		return false
	}
	const url = 'https://try.jd.com/'
	const eventName = `login_status_retrieval_event`
	const result = await openByIframeAndWaitForClose(url, eventName, IFRAME_LIFETIME)
	if (result === TIMEOUT_ERROR) {
		return loginStatusRetrieval(retry + 1)
	}
	else if (!result.login) {
		let autoLogin
		await storage.get({ autoLogin: false }).then(res => { autoLogin = res.autoLogin })

		if (!autoLogin) {
			notifications('未检查到用户名，请手动登录', 'login-fail', true)
			return false
		}

		let accountInfo = true
		await storage.get({ account: { username: '', password: '' } })
			.then(res => {
				if (!res.account.username || !res.account.password)
					accountInfo = false
			})
		if (!accountInfo) {
			notifications('自动登录失败，未保存账号。请点击打开登录界面保存账号', 'login-fail', true)
			return false
		}

		const url = 'https://passport.jd.com/new/login.aspx'
		const eventName = `login_status_retrieval_event`
		const result = await openByIframeAndWaitForClose(url, eventName, IFRAME_LIFETIME)
		if (result === TIMEOUT_ERROR || !result.login) {
			notifications('自动登录失败，请手动登录', 'login-fail', true)
			return false
		}
	}
	return true
}
window.followVenderNumberRetrieval = async function () {
	runtime.totalTask = 1
	runtime.doneTask = 1
	const url = 'https://t.jd.com/follow/vender/list.do?index=1'
	const eventName = 'bg_follow_vender_num_retrieval_event'
	const result = await openByIframeAndWaitForClose(url, eventName, IFRAME_LIFETIME * 2)
	if (result === TIMEOUT_ERROR) {
		notifications('获取关注数量超时')
	}
	else {
		notifications(`获取关注数量完成，一共关注了${saveinfo.followVenderNum}个店铺`)
	}
	taskDone()
}
window.emptyFollowVenderList = async function () {

	runtime.doneTask = 0
	runtime.totalTask = saveinfo.followVenderNum > 0 ? saveinfo.followVenderNum : 500

	const url = 'https://t.jd.com/follow/vender/list.do'
	const eventName = 'empty_follow_vender_list_event'
	await openByIframeAndWaitForClose(url, eventName, 2 * 60 * 1000) // 保留 iframe 两分钟
	notifications(`已完成清理关注店铺列表，当前关注数量为${saveinfo.followVenderNum}`)
	taskDone()

}

window.checkLoginStatusValid = async function () {
	if (loginStatus.status !== USER_STATUS.LOGIN
		|| DateTime.local().valueOf() > loginStatus.timestamp + 30 * 60 * 1000) {//半小时

		loginStatus = Object.assign(loginStatus, {
			status: USER_STATUS.WARMING,
			description: '正在获取登录状态',
			shortDescription: '正在检查',
			timestamp: 0,
		})
		return loginStatusRetrieval()
	}
	return true
}
function taskDone() {
	runtime.taskId = -1
	emitter.emit('taskDone')
	savePersistentData()
}
window.runTask = async function (task, applyTaskDone = false) {

	console.log(`即将执行 ${task.title}`)

	runtime.taskId = task.id
	task.last_run_at = DateTime.local().valueOf()
	updateTaskInfo(task)
	switch (task.action) {
		case 'follow_vender_num_retrieval':
			followVenderNumberRetrieval()
			break
		case 'empty_follow_vender_list':
			if (applyTaskDone) {   //避免当天关注当天取关
				doneTask()
				break
			}
			emptyFollowVenderList()
			break
		case 'activity_retrieval':
			activityRetrieval()
			break
		case 'success_activity_retrieval':
			successActivityRetrieval()
			break
		case 'activity_apply':
			const items = await getActivityItems(1)
			let deleteIds
			await storage.get({ activity_sql_delete_ids: [] }).then(res => deleteIds = res.activity_sql_delete_ids)
			const activity = items.filter(item => {
				if (deleteIds.indexOf(item.id) >= 0) {
					return false
				}
				return item.status === ACTIVITY_STATUS.APPLY
			})
			activityApply(activity)
			break
		default:
			taskDone()
			break
	}
}

function checkAndResetDailyInfo() {
	const day = DateTime.local().day
	if (day !== saveinfo.day) {
		saveinfo.day = day
		saveinfo.fulfilled = false
		saveinfo.applidActivityNum = 0
		initScheduledTasks()
	}

	chrome.alarms.clear('daily')
	chrome.alarms.create('daily', {
		when: DateTime.local().plus({ day: 1 }).set({
			hour: 0,
			minute: 10,
			second: 0,
		}).valueOf()
	})
}

async function autoRun(when) {
	if (runtime.taskId !== -1) {
		setTimeout(() => { autoRun(when) }, 10 * 60 * 1000)
		return
	}
	const login = await loginStatusRetrieval()
	if (!login) {
		console.warn('自动执行失败，登录状态有误')
		return
	}
	updateNotificationPermission(false)
	const allTasks = await getAllTasks()

	const now = DateTime.local()
	const applyTask = allTasks[allTasks.length - 1]
	const applyTaskDone = now.day === DateTime.fromMillis(applyTask.last_run_at).day

	for (let task of allTasks) {
		if (task.auto.run !== true || when != task.auto.when) { // use !=
			continue
		}
		if (task.frequency === 'daily' && now.day === DateTime.fromMillis(task.last_run_at).day) {
			console.log('当天已执行 ', task)
			continue  //已经执行过了
		}
		console.log('即将自动执行', task)
		runTask(task, applyTaskDone)
		await waitEventWithPromise('taskDone', 30 * 60 * 1000) //半个小时
	}
	savePersistentData()
	updateNotificationPermission(true)
}

async function initScheduledTasks() {
	//每次加载插件会执行一次
	//每天执行一次
	//每次更新自动任务执行一次

	for (let i = 0; i < 24; i++) {
		chrome.alarms.clear(`scheduled_${i}`)
	}

	const nowHour = DateTime.local().hour
	const autorunat = []
	const allTasks = await getAllTasks()
	for (let task of allTasks) {
		if (task.auto.run !== true || nowHour >= task.auto.when) {
			continue
		}
		if (autorunat.indexOf(task.auto.when) === -1) {
			autorunat.push(task.auto.when)
		}
	}
	for (let when of autorunat) {
		let timestamp = DateTime.local().set({
			hour: when,
			minute: 1,
			second: 0,
		})
		chrome.alarms.create(`scheduled_${when}`, {
			when: timestamp.valueOf()
		})
		console.log(`scheduled_${when} auto run at ${timestamp}`)
	}

}
function updateBrowserAction() {
	switch (loginStatus.status) {
		case USER_STATUS.LOGIN:
			chrome.browserAction.getBadgeText({}, text => {
				if (text === "") {
					return
				}
				chrome.browserAction.setBadgeText({
					text: ""
				});
				chrome.browserAction.setTitle({
					title: "京试"
				})
			})
			break
		case USER_STATUS.LOGOUT:
			chrome.browserAction.setBadgeBackgroundColor({
				color:"#FF2800"
			})
			chrome.browserAction.setBadgeText({
				text: "!"
			})
			chrome.browserAction.setTitle({
				title: "账号登录失效"
			})
			break
		default:
			break
	}
}

window.onload = () => {
	console.log(`${DateTime.local()} background.js loading`)
	chrome.alarms.clearAll()
	storage.get({ saveinfo: saveinfo }).then(res => saveinfo = res.saveinfo).then(checkAndResetDailyInfo)
	initScheduledTasks()
}

window.onunload = () => {
	savePersistentData()
}