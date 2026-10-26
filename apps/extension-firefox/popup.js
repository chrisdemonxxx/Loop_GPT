const status = document.getElementById('status')
const button = document.getElementById('connect')
const title = document.getElementById('title')

chrome.runtime.sendMessage({ type: 'status' }, (current) => {
  if (!current) return
  if (current.pairedElsewhere) lock('This browser is already paired to another Loop account.')
  else if (current.paired) status.textContent = 'Connected.'
})

chrome.storage.local.get(['apiOrigin', 'profileLabel', 'pairedElsewhere']).then((stored) => {
  if (stored.apiOrigin) document.getElementById('origin').value = stored.apiOrigin
  if (stored.profileLabel) document.getElementById('profile').value = stored.profileLabel
  if (stored.pairedElsewhere) lock('This browser is already paired to another Loop account.')
})

button.addEventListener('click', () => {
  button.disabled = true
  status.textContent = 'Connecting…'
  chrome.runtime.sendMessage({
    type: 'pair',
    code: document.getElementById('code').value,
    apiOrigin: document.getElementById('origin').value,
    profileLabel: document.getElementById('profile').value,
  }, (result) => {
    button.disabled = false
    if (result?.pairedElsewhere) lock('This browser is already paired to another Loop account.')
    else if (result?.ok) status.textContent = 'Connected. You can name this device on Agents.'
    else status.textContent = result?.error || 'Could not connect.'
  })
})

function lock(message) {
  button.disabled = true
  button.textContent = 'Connect to Loop'
  title.textContent = 'Already paired'
  status.textContent = message
  for (const id of ['code', 'profile', 'origin']) document.getElementById(id).disabled = true
}
