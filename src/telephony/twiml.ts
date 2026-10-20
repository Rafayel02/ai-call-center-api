const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function sayTwiml(text: string) {
  return `${XML_HEAD}<Response><Say>${escapeXml(text)}</Say><Hangup/></Response>`;
}

export function streamTwiml(streamUrl: string, token: string) {
  return `${XML_HEAD}<Response><Connect><Stream url="${escapeXml(streamUrl)}"><Parameter name="token" value="${escapeXml(token)}"/></Stream></Connect><Hangup/></Response>`;
}

export function hangupTwiml() {
  return `${XML_HEAD}<Response><Hangup/></Response>`;
}

export function gatherTwiml(action: string, playUrls: string[]) {
  const plays = playUrls.map((url) => `<Play>${escapeXml(url)}</Play>`).join('');
  return `${XML_HEAD}<Response><Gather input="dtmf" numDigits="1" timeout="12" action="${escapeXml(action)}" method="POST">${plays}</Gather><Hangup/></Response>`;
}
