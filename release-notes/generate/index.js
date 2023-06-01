import * as fs from "node:fs/promises";
import { join } from "node:path";
import { promisify, inspect } from "node:util";
import * as childProcess from "node:child_process";
import matter from "gray-matter";
import listify from "listify";

import { categoryOrder } from "../util.js";

const exec = promisify(childProcess.exec);

collapsedLog("Environment", process.env);

const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");

const apiResult = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    query: /* GraphQL */ `
      query GetPRMetadata(
        $name: String!
        $owner: String!
        $headRefName: String!
      ) {
        repository(name: $name, owner: $owner) {
          pullRequests(headRefName: $headRefName, first: 1) {
            edges {
              node {
                number
                baseRef {
                  target {
                    oid
                  }
                }
                headRefName
              }
            }
          }
        }
      }
    `,
    variables: {
      name: repo,
      owner,
      headRefName: process.env.GITHUB_HEAD_REF,
    },
  }),
}).then((res) => res.json());

collapsedLog("API Response", apiResult);

const prData = apiResult.data.repository.pullRequests.edges[0].node;

await setOutput("pr_number", prData.number);
const version = prData.headRefName.split("/")[1];
const baseRef = prData.baseRef.target.oid;

await group("Checkout base ref in worktree", async () => {
  await exec(`git fetch origin ${baseRef}`, { stdio: "inherit" });
  await exec(`git worktree add ../../tmp ${baseRef}`, {
    stdio: "inherit",
  });
});

const notes = printNotes(
  await parseReleaseNotes("../../tmp/upcoming-release-notes")
);

collapsedLog("Release Notes", notes);

await setOutput(
  "comment",
  `<!-- auto-generated-release-notes -->\nHere are the automatically generated release notes!\n\n~~~markdown\n${notes}\n~~~`
);

const releaseNotes = await fs
  .readdir("upcoming-release-notes")
  .then((contents) =>
    contents.filter((f) => f.endsWith(".md") && f !== "README.md")
  );

if (releaseNotes.length === 0) {
  console.log("No release notes found, no cleanup needed");
  process.exit(0);
}

await group("Remove used release notes", async () => {
  await exec("rm -r upcoming-release-notes/*.md", { stdio: "inherit" });
  await exec("git checkout upcoming-release-notes/README.md", {
    stdio: "inherit",
  });
});

await group("Commit and push", async () => {
  await exec("git add upcoming-release-notes", { stdio: "inherit" });
  const name = "github-actions[bot]";
  const email = "41898282+github-actions[bot]@users.noreply.github.com";
  await exec("git commit -m 'Remove used release notes'", {
    stdio: "inherit",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_COMMITTER_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_EMAIL: email,
    },
  });
  await exec("git push origin HEAD:" + process.env.GITHUB_HEAD_REF, {
    stdio: "inherit",
  });
});

async function parseReleaseNotes(dir) {
  const notes = (await fs.readdir(dir))
    .filter((f) => f.match(/^\d+\.md$/))
    .map(async (name) => {
      const content = await fs.readFile(join(dir, name), "utf-8");
      const { data, content: body } = matter(content);
      const number = name.replace(".md", "");
      const authors = listify(
        data.authors.map((a) => `[${a}]`),
        { finalWord: "&" }
      );
      return {
        category: data.category,
        value: `- [#${number}](https://github.com/actualbudget/${repo}/pull/${number}) ${body.trim()} \u{2014} thanks ${authors}`,
      };
    });

  return (await Promise.all(notes)).reduce((acc, note) => {
    if (!acc[note.category]) {
      console.log(`WARNING: Unrecognized category "${note.category}"`);
      acc[note.category] = [];
    }
    acc[note.category].push(note.value);
    return acc;
  }, Object.fromEntries(categoryOrder.map((c) => [c, []])));
}

function printNotes(notes) {
  const printedNotes = Object.entries(notes).map(
    ([category, values]) => `#### ${category}\n\n${values.join("\n")}`
  );
  return `Version: ${version}\n\n${printedNotes.join("\n\n")}`;
}

async function collapsedLog(name, value) {
  group(name, () => {
    if (typeof value === "string") {
      console.log(value);
    } else {
      console.log(inspect(value, { depth: null }));
    }
  });
}

async function group(name, cb) {
  console.log(`::group::${name}`);
  await cb();
  console.log("::endgroup::");
}

async function setOutput(name, value) {
  const delimiter = Math.random().toString(36).slice(2);
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    `\n${name}<<${delimiter}\n${value}\n${delimiter}\n`
  );
}
