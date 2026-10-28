import { WikiNode } from '../types';
import { SkillGroup } from '../types/tabTypes';
import { assertWorkspaceUser, isLocalOnlyWorkspace, workspaceUser } from './workspaceStorage';
import { listLocalSkills, readLocalConstraint } from './localLibrary';

export const resolveSkillGroup = (node: WikiNode, nodes: WikiNode[], groups: SkillGroup[]): SkillGroup | undefined => {
    const byId = new Map(nodes.map(item => [item.id, item]));
    const visited = new Set<string>();
    let current: WikiNode | undefined = node;
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        const group = groups.find(item => item.id === current?.skillGroupId);
        if (group) return group;
        current = byId.get(current.parentId || '');
    }
};

export const buildSkillConstraints = async (group?: SkillGroup, systemSkillIds: string[] = [], globalMdPath = '', expectedUser = workspaceUser()): Promise<string> => {
    assertWorkspaceUser(expectedUser);
    const ids = [...new Set([...systemSkillIds, ...(group?.skillIds || [])])];
    if (!group && !ids.length && !globalMdPath.trim()) return '';
    let globalConstraint = '';
    if (globalMdPath.trim()) {
        if (isLocalOnlyWorkspace()) {
            const content = await readLocalConstraint(globalMdPath.trim());
            if (!content) throw new Error('当前工作区没有这个约束文件，请先导入或检查文件名。');
            globalConstraint = `### Global Markdown constraint: ${globalMdPath.trim()}\n${content.trim()}`;
        } else {
            const response = await fetch(`/api/constraints?path=${encodeURIComponent(globalMdPath.trim())}`);
            if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Local constraint API unavailable. Open the current dev server URL and reload.');
            const result = await response.json();
            assertWorkspaceUser(expectedUser);
            if (!response.ok) throw new Error(result.error || 'Could not read global Markdown constraint.');
            globalConstraint = `### Global Markdown constraint: ${globalMdPath.trim()}\n${result.content.trim()}`;
        }
    }
    let skills: { id: string; name: string; content: string }[] = [];
    if (ids.length) {
        if (isLocalOnlyWorkspace()) skills = await listLocalSkills();
        else {
            const response = await fetch('/api/skills');
            if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Local skill library unavailable. Open the current dev server URL and reload.');
            skills = (await response.json()).skills;
        }
        assertWorkspaceUser(expectedUser);
        const missing = ids.filter(id => !skills.some(skill => skill.id === id));
        if (missing.length) throw new Error(`Missing local skills: ${missing.join(', ')}. Restore them in the skill folder before generating.`);
    }
    const resources = (group?.resources || [])
        .filter(resource => resource.content.trim())
        .map(resource => `### ${resource.kind === 'skill' ? 'Skill' : 'Markdown reference'}: ${resource.name}\n${resource.content.trim()}`);
    const selected = ids.map(id => skills.find(skill => skill.id === id)!)
        .map(skill => `### Skill: ${skill.name}\n${skill.content.trim()}`);
    const constraints = [globalConstraint, ...resources, ...selected].filter(Boolean).join('\n\n');
    assertWorkspaceUser(expectedUser);
    if (constraints.length > 100000) throw new Error('Combined skill constraints exceed 100,000 characters. Remove some resources or skills.');
    return constraints;
};
