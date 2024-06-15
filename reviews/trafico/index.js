import { Trafico } from './trafico'
import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'

async function runTrafico () {
  try {
    const token = core.getInput('github-token')
    const { owner, repo } = context.repo
    const { rest } = getOctokit(token)
    const trafico = new Trafico(rest, { owner, repo })

    const pullRequest = await rest.pulls.get({
      owner,
      repo,
      pull_number: context.payload.pull_request.number
    })

    trafico.runTrafico(context, pullRequest, {})
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

runTrafico()
