function isRoot(folderPath: string): boolean {
	return folderPath === "" || folderPath === "/";
}

export function isUnderFolder(path: string, folderPath: string): boolean {
	if (isRoot(folderPath)) return true;
	return path.startsWith(`${folderPath}/`);
}

export function repathToFolder(path: string, oldFolderPath: string, newFolderPath: string): string {
	if (isRoot(oldFolderPath)) return path;
	if (!isUnderFolder(path, oldFolderPath)) return path;
	return newFolderPath + path.slice(oldFolderPath.length);
}
