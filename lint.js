#!/usr/bin/env node

const yaml = require('js-yaml');
const fs = require('fs');
const glob = require('fast-glob');

const collectResources = require('./collect-resources')

const docs = [];
const files = glob.sync(process.argv.slice(2));

for (const file of files) {
  for (const doc of yaml.safeLoadAll(fs.readFileSync(file, 'utf-8'))) {
    docs.push(doc);
  }
}

const tekton = {
  tasks: Object.fromEntries(docs.filter(item => item.kind === 'Task').map(item => [
    item.metadata.name,
    item,
  ])),
  pipelines: Object.fromEntries(docs.filter(item => item.kind === 'Pipeline').map(item => [
    item.metadata.name,
    item,
  ])),
  listeners: Object.fromEntries(docs.filter(item => item.kind === 'EventListener').map(item => [
    item.metadata.name,
    item,
  ])),
  triggerTemplates: Object.fromEntries(docs.filter(item => item.kind === 'TriggerTemplate').map(item => [
    item.metadata.name,
    item,
  ])),
  triggerBindings: Object.fromEntries(docs.filter(item => item.kind === 'TriggerBinding').map(item => [
    item.metadata.name,
    item,
  ])),
};

function walk(node, path, visitor) {
  if (typeof node === 'string' || typeof node === 'number') {
    visitor(node, path);
  } else if (Array.isArray(node)) {
    for (const [index, child] of Object.entries(node)) {
      walk(child, path + `[${index}]`, visitor);
    }
  } else {
    if (!node) return;
    for (const [key, value] of Object.entries(node)) {
      walk(value, path + `.${key}`, visitor);
    }
  }
}

const unused = (resource, params, prefix) => (node, path) => {
  const r1 = new RegExp(`\\$\\(${prefix}.(.*?)\\)`, 'g');
  const r2 = new RegExp(`\\$\\(${prefix}.(.*?)\\)`);
  const m = node.match(r1);
  if (!m) return;
  for (const item of m) {
    const m2 = item.match(r2);
    const param = m2[1];
    if (typeof params[param] === 'undefined') {
      console.log(`Undefined param '${param}' at ${path} in '${resource}'`);
    } else {
      params[param]++;
    }
  }
};

const validateRunAfterTaskSteps = (pipelineName, pipelineTasks) => {
  const isTaskExists = step => pipelineTasks.map(task => task.name).includes(step);

  pipelineTasks.forEach(({ runAfter, name, taskRef }) => {
    if (!runAfter) return;

    runAfter.forEach(step => {
      if (step === name) console.log(`Pipeline '${pipelineName}' defines task '${taskRef.name}' (as '${name}'), but it's runAfter step '${step}' cannot be itself.`);
      if (!isTaskExists(step)) console.log(`Pipeline '${pipelineName}' defines task '${taskRef.name}' (as '${name}'), but it's runAfter step '${step}' not exist.`);
    });
  });
}

const isValidName = (name) => {
  const valid = new RegExp(`^[a-z\-\(\)\$]*$`);
  return valid.test(name)
}

const naming = (resource, prefix) => (node, path) => {
  const r2 = new RegExp(`\\$\\(${prefix}.(.*?)\\)`);

  const m = node.match(r2);
  let name = node
  if (m) {
    name = m[1]
  }

  if (!isValidName(name)) {
    console.log(`Invalid name for '${name}' at ${path} in '${resource}'. Names should be in lowercase, alphanumeric, kebab-case format.`);
  }
}


const resources = collectResources(docs);

Object.entries(resources).map(([type, resourceList]) => {
  Object.entries(resourceList).forEach(([name, resource]) => {
    if (!isValidName(resource.metadata.name)) {
      console.log(`Invalid name for ${type} '${resource.metadata.name}'. Names should be in lowercase, alphanumeric, kebab-case format.`);
    }
  });
});

for (const task of Object.values(tekton.tasks)) {
  if (!task.spec) continue;

  const params = Object.fromEntries(task.spec.inputs.params.map(param => [param.name, 0]));

  walk(task.spec.steps, 'spec.steps', unused(task.metadata.name, params, 'inputs.params'));
  walk(task.spec.volumes, 'spec.volumes', unused(task.metadata.name, params, 'inputs.params'));

  for (const param of Object.keys(params)) {
    if (params[param]) continue;
    console.log(`Task '${task.metadata.name}' defines parameter '${param}', but it's not used anywhere in the task spec`);
  }
}

for (const listener of Object.values(tekton.listeners)) {
  for (const [index, trigger] of Object.entries(listener.spec.triggers)) {
    if (!trigger.template) continue;
    const name = trigger.template.name;
    if (!tekton.triggerTemplates[name]) {
      console.log(`EventListener '${listener.metadata.name}' defines trigger template '${name}', but the trigger template is missing.`)
      continue;
    }
  }
  for (const [index, trigger] of Object.entries(listener.spec.triggers)) {
    if (!trigger.binding) continue;
    const name = trigger.binding.name;
    if (!tekton.triggerBindings[name]) {
      console.log(`EventListener '${listener.metadata.name}' defines trigger binding '${name}', but the trigger binding is missing.`)
      continue;
    }
  }
}

for (const pipeline of Object.values(tekton.pipelines)) {
  const params = Object.fromEntries(pipeline.spec.params.map(param => [param.name, 0]));

  validateRunAfterTaskSteps(pipeline.metadata.name, pipeline.spec.tasks);

  walk(pipeline.spec.tasks, 'spec.steps', unused(pipeline.metadata.name, params, 'params'));
  walk(pipeline.spec.tasks, 'spec.steps', naming(pipeline.metadata.name, 'params'));

  for (const param of Object.keys(params)) {
    if (params[param]) continue;
    console.log(`Pipeline '${pipeline.metadata.name}' defines parameter '${param}', but it's not used anywhere in the pipeline spec`);
  }

  for (const [index, task] of Object.entries(pipeline.spec.tasks)) {
    if (!task.taskRef) continue;
    const name = task.taskRef.name;
    if (!tekton.tasks[name]) {
      console.log(`Pipeline '${pipeline.metadata.name}' references task '${name}' but the referenced task cannot be found. To fix this, include all the task definitions to the lint task for this pipeline.`);
      continue;
    }

    const provided = task.params.map(param => param.name);
    const all = tekton.tasks[name].spec.inputs.params
      .map(param => param.name);
    const required = tekton.tasks[name].spec.inputs.params
      .filter(param => typeof param.default == 'undefined')
      .map(param => param.name);

    const extra = provided.filter(p => !all.includes(p));
    const missing = required.filter(p => !provided.includes(p));

    for (const param of extra) {
      console.log(`Pipeline '${pipeline.metadata.name}' references task '${name}' (as '${task.name}'), and supplies parameter '${param}' to it, but it's not a valid parameter`);
    }

    for (const param of missing) {
      console.log(`Pipeline '${pipeline.metadata.name}' references task '${name}' (as '${task.name}'), but parameter '${param}' is not supplied (it's a required param in '${name}')`);
    }
  }

  for (const template of Object.values(tekton.triggerTemplates)) {
    const matchingResource = template.spec.resourcetemplates.find(item => item.spec && item.spec.pipelineRef &&item.spec.pipelineRef.name === pipeline.metadata.name);
    if (matchingResource) {
      const pipelineParams = pipeline.spec.params;
      const templateParams = matchingResource.spec.params;

      const missing = pipelineParams.filter(pipelineParam => !templateParams.some(templateParam => templateParam.name === pipelineParam.name) && typeof pipelineParam.default === 'undefined');
      const extra = templateParams.filter(templateParam => !pipelineParams.some(pipelineParam => pipelineParam.name === templateParam.name));
      for (const param of extra) {
        console.log(`TriggerTemplate '${template.metadata.name}' defines parameter '${param.name}', but it's not used anywhere in the pipeline spec '${pipeline.metadata.name}'`);
      }

      for (const param of missing) {
        console.log(`Pipeline '${pipeline.metadata.name}' references param '${param.name}', but it is not supplied in triggerTemplate '${template.metadata.name}'`);
      }
    }
  }
}
