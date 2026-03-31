document.addEventListener('DOMContentLoaded', () => {
    const pickFilesBtn = document.getElementById('pickFilesBtn');
    const pickFolderBtn = document.getElementById('pickFolderBtn');
    const filesInput = document.getElementById('filesInput');
    const folderInput = document.getElementById('folderInput');
    const jsonData = document.getElementById('jsonData');

    const readTextFile = (file) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file);
        });
    };

    const detectFileType = (file) => {
        const name = (file.name || '').toLowerCase();
        if (name.endsWith('.json') || file.type === 'application/json') return 'json';
        if (name.endsWith('.txt') || file.type === 'text/plain') return 'txt';
        return 'unknown';
    };

    const appendTitle = (text) => {
        const title = document.createElement('h3');
        title.textContent = text;
        jsonData.appendChild(title);
    };

    const appendTextBlock = (text) => {
        const p = document.createElement('p');
        p.textContent = text;
        jsonData.appendChild(p);
    };

    const appendJsonBlock = (data) => {
        if (typeof data !== 'object' || data === null) {
            appendTextBlock('JSON 内容不是对象，无法按字段渲染。');
            return;
        }

        const ul = document.createElement('ul');
        Object.entries(data).forEach(([key, value]) => {
            const li = document.createElement('li');
            li.textContent = `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
            ul.appendChild(li);
        });
        jsonData.appendChild(ul);

        const rawTitle = document.createElement('h4');
        rawTitle.textContent = 'Raw JSON';
        jsonData.appendChild(rawTitle);

        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(data, null, 2);
        jsonData.appendChild(pre);
    };

    const renderSingleFile = async (file, displayName) => {
        const type = detectFileType(file);
        appendTitle(displayName || file.name);

        if (type === 'txt') {
            const content = await readTextFile(file);
            appendTextBlock(content);
            return;
        }

        if (type === 'json') {
            const content = await readTextFile(file);
            const parsed = JSON.parse(content);
            appendJsonBlock(parsed);
            return;
        }

        appendTextBlock(`不支持的文件类型: ${file.name}`);
    };

    const renderFiles = async (files, sourceLabel) => {
        jsonData.replaceChildren();
        const source = document.createElement('h2');
        source.textContent = sourceLabel;
        jsonData.appendChild(source);

        for (const file of files) {
            const fileName = file.webkitRelativePath || file.name;
            try {
                await renderSingleFile(file, fileName);
            } catch (error) {
                appendTitle(fileName);
                appendTextBlock(`读取失败: ${error?.message || '未知错误'}`);
                console.error('Read/render error:', fileName, error);
            }
        }
    };

    pickFilesBtn.addEventListener('click', () => {
        filesInput.click();
    });

    pickFolderBtn.addEventListener('click', () => {
        folderInput.click();
    });

    filesInput.addEventListener('change', async (event) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        await renderFiles(files, '来源: 文件选择');
        filesInput.value = '';
    });

    folderInput.addEventListener('change', async (event) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        await renderFiles(files, '来源: 文件夹选择');
        folderInput.value = '';
    });
});