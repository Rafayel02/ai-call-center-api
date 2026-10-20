const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function hangUpTwiml() {
  return `${XML_HEAD}<Response><Hangup/></Response>`;
}

/** Opens a bidirectional media stream. Twilio runs `<Hangup/>` once the API closes the stream. */
export function streamTwiml(streamUrl: string, parameters: Record<string, string>) {
  const params = Object.entries(parameters)
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}"/>`)
    .join('');
  return `${XML_HEAD}<Response><Connect><Stream url="${escapeXml(streamUrl)}">${params}</Stream></Connect><Hangup/></Response>`;
}
