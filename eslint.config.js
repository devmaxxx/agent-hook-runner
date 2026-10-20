// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'lib',
  },
  {
    // Fixtures spell out `${VAR}` literally: that is the command being parsed.
    files: ['test/**/*.ts'],
    rules: {
      'no-template-curly-in-string': 'off',
    },
  },
)
