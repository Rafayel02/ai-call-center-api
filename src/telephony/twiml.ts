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
