// Spintext: resolves {option1|option2|option3} syntax by randomly picking one option per group.
// Safe to call on any string — if no {} groups are present, returns the string unchanged.
const spintext = (body) => {
  if (!body) return body
  return body.replace(/\{([^{}]+)\}/g, (_, options) => {
    const choices = options.split('|').map(s => s.trim()).filter(Boolean)
    if (choices.length === 0) return ''
    return choices[Math.floor(Math.random() * choices.length)]
  })
}

module.exports = { spintext }
