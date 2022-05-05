const glob = require("glob");
const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const iconv = require('iconv-lite');
const { execSync } = require('child_process');
const engine = require('php-parser');

_.mixin({
    'pascalCase': function (string) {
        return _.startCase(string).replace(/\s/g, '');
    },
    'isPascalCase': function (string) {
        return string === _.pascalCase(string);
    },
});

const parser = new engine({
    parser: {
        extractDoc: false,
        php7: true,
        suppressErrors: true,
    },
    ast: {
        withPositions: false,
        withSource: false,
    },
    lexer: {
        all_tokens: true,
        short_tags: true,
    }
});

class Runner {

    basePath = '';

    files = [];

    exclude = [
        /\.git/,
        /PHPExcel/,
        /\/Core\/lib/,
        /\/Core\/data/,
    ];

    constructor(basePath) {
        this.basePath = basePath;
    }

    /**
     *
     * @returns {Promise<void>}
     */
    async start() {
        // Reseta o proejto para uma execução limpa
        execSync('git reset HEAD --hard && git clean -fdx', {cwd: this.basePath});

        this
            .renameFolders()
            .loadFiles()
            .renameFiles()
            .setNamespacesRoot()
            .generalReplaces()
            .generateNamespaces()
            .generateUses()
            .persist()
            .end();
    }

    /**
     *
     */
    loadFiles() {
        this.files = glob.sync(`**/**/*{.php,.phtml}`, {
            cwd: path.resolve(process.cwd(), this.basePath),
            ignore: this.exclude.map(regex => {
                const regexToGlob = regex
                    .toString()
                    .replaceAll('\\', '')
                    .replaceAll('//', '/')

                return `**${regexToGlob}**`
            }),
        }).map(file => {
            const contents = this.readFile(file);

            return {
                path: file,
                className: path.basename(file, '.php'),
                contents,
            }
        });

        return this;
    }

    setNamespacesRoot() {
        const composerPath = path.resolve(this.basePath, 'composer.json');

        let composer = require(composerPath);
        composer = {
            ...composer,
            autoload: {
                'psr-4': {
                    'Infrashop\\Site\\App\\': 'App/',
                    'Infrashop\\Site\\Core\\': 'Core/',
                }
            },
            require: {
                php: '>=8.0'
            }
        };

        fs.writeFileSync(composerPath, JSON.stringify(composer, null, 4));

        return this;
    }

    generalReplaces() {
        const rules =  [
            {
                search: '\\Exception',
                replace: `Exception`,
            },
            {
                search: '\\Model',
                replace: `Model`,
            },
        ];

        this.replaceInAllFiles(rules);

        return this;
    }

    /**
     *
     * @returns {Runner}
     */
    generateNamespaces() {
        this.files = this.files.map(file => {
            const {dir} = path.parse(file.path);

            const namespace = `Infrashop\\Site\\${dir.replaceAll('\/', '\\')}`;

            return {
                ...file,
                namespace,
            }
        });

        return this;
    }

    /**
     *
     * @returns {Runner}
     */
    generateUses() {
        this.files = this.files.map(file => {
            const uses = this.getClassUses(file);

            return {
                ...file,
                uses,
            };
        });

        return this;
    }

    /**
     *
     * @param file
     * @returns {string[]}
     */
    getClassUses(file) {
        // const teste = this.readFileTest();
        //
        // const testParsed = parser.parseCode(this.sanitizeFileCode(teste));
        //
        // let usesTeste = this.getClassUsesRecursively(testParsed);
        // usesTeste = _.flattenDeep(usesTeste).filter(n => n);
        // usesTeste = _.uniq(usesTeste);
        //
        // console.log(usesTeste);
        //
        // process.exit(0);

        const parsed = parser.parseCode(this.sanitizeFileCode(file.contents));

        let uses = this.getClassUsesRecursively(parsed);
        uses = _.flattenDeep(uses).filter(n => n);
        uses = _.uniq(uses);

        uses = uses.map(className => {
            if (className === file.className) {
                return;
            }

            if (new RegExp(`use(\\s+)[\\\\]?(.+)\\\\${className};`, 'g').test(file.contents)) {
                return;
            }

            if (new RegExp(`(class|interface)(\\s+)${className}(\\s+)`, 'g').test(file.contents)) {
                return;
            }

            const classFile = this.files.find(file => className === file.className);

            if (!classFile) {
                return className;
            }

            return `${classFile.namespace}\\${className}`;
        }).filter(n => n)

        return uses;
    }

    sanitizeFileCode(contents) {
        return contents.replaceAll(/use(\s+)\\(.+);/g, '');
    }

    /**
     *
     * @param ast
     * @returns []
     */
    getClassUsesRecursively(ast) {
        if (_.isEmpty(ast)) {
            return [];
        }

        const children = ast.children || ast.body || ast.items;

        if (_.isArray(ast)) {
            return ast.map(child => this.getClassUsesRecursively(child));
        }

        if (_.get(ast, 'kind') === 'class') {
            return [
                this.getClassNameByAst(ast.extends),
                (ast.implements || []).map(implementsAst => this.getClassNameByAst(implementsAst)),
                this.getClassUsesRecursively(ast.body),
            ];
        }

        if (_.get(ast, 'kind') === 'method') {
            return [
                this.getClassUsesRecursively(ast.arguments),
                this.getClassUsesRecursively(ast.body),
            ];
        }

        if (!_.isEmpty(ast.expression)) {
            return this.getClassUsesRecursively(ast.expression);
        }

        if (_.get(ast, 'kind') === 'try') {
            return [
                this.getClassUsesRecursively(ast.body),
                this.getClassUsesRecursively(ast.catches),
            ];
        }

        if (_.get(ast, 'kind') === 'if') {
            return [
                this.getClassUsesRecursively(ast.test),
                this.getClassUsesRecursively(ast.body),
                this.getClassUsesRecursively(ast.alternate),
            ];
        }

        if (_.get(ast, 'kind') === 'retif') {
            return [
                this.getClassUsesRecursively(ast.test),
                this.getClassUsesRecursively(ast.trueExpr),
                this.getClassUsesRecursively(ast.falseExpr),
            ];
        }

        if (_.get(ast, 'type') === 'instanceof') {
            return this.getClassNameByAst(ast.right);
        }

        if (_.get(ast, 'kind') === 'return') {
            return this.getClassUsesRecursively(ast.expr);
        }

        // Trata elementos de um array
        if (_.get(ast, 'kind') === 'entry') {
            return this.getClassUsesRecursively(ast.value);
        }

        if (_.get(ast, 'kind') === 'unary') {
            return this.getClassUsesRecursively(ast.what);
        }

        if (_.get(ast, 'kind') === 'throw') {
            return this.getClassUsesRecursively(ast.what);
        }

        if (_.get(ast, 'kind') === 'echo') {
            return this.getClassUsesRecursively(ast.expressions);
        }

        if (
            _.get(ast, 'kind') === 'parameter' &&
            !_.isEmpty(_.get(ast, 'type'))
        ) {
            return this.getClassNameByAst(ast.type);
        }

        // Utilizado para mapear os componentes de um if
        if (
            _.get(ast, 'kind') === 'bin' ||
            _.get(ast, 'kind') === 'assign'
        ) {
            return [
                this.getClassUsesRecursively(ast.left),
                this.getClassUsesRecursively(ast.right),
            ];
        }

        if (_.get(ast, 'kind') === 'new') {
            return [
                _.get(ast, 'what.name'),
                this.getClassUsesRecursively(ast.arguments),
            ]
        }

        if (_.get(ast, 'kind') === 'call') {
            return [
                this.getClassUsesRecursively(ast.what),
                this.getClassUsesRecursively(ast.arguments),
            ];
        }

        if (_.get(ast, 'kind') === 'staticlookup') {
            return this.getClassNameByAst(ast.what);
        }

        if (_.get(ast, 'kind') === 'catch') {
            return ast.what.map(exceptionAst => this.getClassNameByAst(exceptionAst));
        }

        if (_.get(ast, 'kind') === 'propertylookup') {
            return this.getClassUsesRecursively(ast.what);
        }

        // console.log(ast);

        if (!_.isEmpty(children)) {
            return this.getClassUsesRecursively(children);
        }
    }

    getClassNameByAst(nameAst) {
        if (_.isEmpty(nameAst) || _.isEmpty(nameAst.resolution)) {
            return;
        }

        if (nameAst.resolution === 'fqn') {
            console.log('# Classe com resolução do tipo FQN (Validar)');
            console.log(nameAst.name);
        }

        return nameAst.name.replace('\\', '')
    }

    /**
     *
     * @param folderPath
     */
    renameFolders() {
        this.renameFoldersRecursively();

        return this;
    }

    /**
     *
     * @param folderPath
     */
    renameFoldersRecursively(folderPath = '') {
        const titleCasePath = folderPath.split('/').map(_.pascalCase).join('/');

        const oldFolderPath = path.join(process.cwd(), this.basePath, folderPath);
        const newFolderPath = path.join(process.cwd(), this.basePath, titleCasePath);

        // Renomeia o path para o padrão PSR-4 (StartCase)
        fs.renameSync(oldFolderPath, newFolderPath);

        const children = this.getFoldersFromPath(newFolderPath, this.exclude);

        children
            .forEach(item => {
                return this.renameFoldersRecursively(path.join(titleCasePath, item.name));
            });
    }

    /**
     *
     * @param folderPath
     * @param exclude
     * @returns {Dirent[]}
     */
    getFoldersFromPath(folderPath, exclude = []) {
        return fs
            .readdirSync(folderPath, {withFileTypes: true})
            .filter(item => {
                if (!item.isDirectory()) {
                    return;
                }

                return !exclude.some(regex => {
                    const pathToTest = path.join(folderPath, item.name);

                    return new RegExp(regex, 'ig').test(pathToTest);
                });
            });
    }

    /**
     *
     * @returns {Runner}
     */
    renameFiles() {
        const filesToRename = this.files
            .map(file => {
                const oldBaseFileName = path.basename(file.path, path.extname(file.path));
                const newBaseFileName = _.pascalCase(oldBaseFileName);

                if (oldBaseFileName === newBaseFileName) {
                    return;
                }

                return {
                    oldPath: file.path,
                    newPath: file.path.replace(oldBaseFileName, newBaseFileName),
                    oldName: oldBaseFileName,
                    newName: newBaseFileName,
                    regex: [
                        {
                            search: new RegExp(`(class)(\\s+)(${oldBaseFileName})`, 'g'),
                            replace: `$1 ${newBaseFileName}`,
                        },
                        {
                            search: new RegExp(`(extends|implements)(\\s+)(${oldBaseFileName})`, 'g'),
                            replace: `$1 ${newBaseFileName}`,
                        },
                        {
                            search: new RegExp(`new(\\s+)(${oldBaseFileName})(\\s+)?(\\((.+)?\\))?(\\s+)?;`, 'g'),
                            replace: `new ${newBaseFileName}$4;`,
                        },
                        {
                            search: new RegExp(`(${oldBaseFileName})(\s+)?::(\s+)?`, 'g'),
                            replace: `${newBaseFileName}::`,
                        },
                    ]
                };
            })
            .filter(n => n);

        // Renomeia os arquivos
        filesToRename.forEach(({oldPath, newPath}) => {
            return this.renameFile(oldPath, newPath);
        });

        // Altera no array global o novo path do arquivo
        this.files = this.files.map(file => {
            const wasRenamed = filesToRename.find(({oldPath}) => oldPath.includes(file.path));

            if (!wasRenamed) {
                return file;
            }

            return {
                ...file,
                path: wasRenamed.newPath,
                className: path.basename(wasRenamed.newPath, path.extname(wasRenamed.newPath)),
            }
        });

        const regexArray = _.flatten(_.map(filesToRename, 'regex'));

        this.replaceInAllFiles(regexArray);

        return this;
    }

    /**
     * Carrega um arquivo e decodifica para UTF-8
     *
     * @param filePath
     * @returns {string}
     */
    readFile(filePath) {
        const contents = fs.readFileSync(path.join(this.basePath, filePath));

        return iconv.decode(contents, 'ISO-8859-1');
    }

    /**
     * @todo remover
     * @param filePath
     * @returns {string}
     */
    readFileTest() {
        const contents = fs.readFileSync('Teste.php');

        return iconv.decode(contents, 'ISO-8859-1');
    }

    /**
     * Escreve o arquivo no encoding correto
     *
     * @param filePath
     * @param contents
     */
    writeFile(filePath, contents) {
        const contentsEncoded = iconv.encode(contents, 'ISO-8859-1');

        return fs.writeFileSync(path.join(this.basePath, filePath), contentsEncoded);
    }

    /**
     * Renomeia um arquivo com base no path base
     *
     * @param oldPath
     * @param newPath
     */
    renameFile(oldPath, newPath) {
        return fs.renameSync(path.join(this.basePath, oldPath), path.join(this.basePath, newPath));
    }

    /**
     *
     * @param regexArray
     * @returns {*}
     */
    replaceInAllFiles(regexArray) {
        this.files = this.files.map(file => {
            regexArray.forEach(({search, replace}) => {
                file.contents = file.contents.replaceAll(search, replace);
            });

            return file;
        });
    }

    /**
     *
     */
    persist() {
        this.files.forEach(file => {
            const namespaceString = `namespace ${file.namespace};`;
            const usesString = file.uses.map(use => `use ${use};`).join('\n');

            if (path.extname(file.path) === '.php') {
                const newContents = file.contents.replace(/((<\?php)|(<\?))/, `<?php\n\n${namespaceString}\n\n${usesString}\n`);

                return this.writeFile(file.path, newContents);
            }

            if (_.isEmpty(file.uses)) {
                return;
            }

            const firstLine = _.first(file.contents.match(/.+/));

            // Verifica se a primeira linha do arquivo é uma abertura de tag PHP
            if (/((<\?php)|(<\?))/.test(firstLine)) {
                const newContents = file.contents.replace(/((<\?php)|(<\?))/, `<?php\n\n${usesString}\n`);

                return this.writeFile(file.path, newContents);
            }

            const newContents = file.contents.replace(/(.+)/, `<?php\n\n${usesString}\n\n?>\n\n$1`);

            return this.writeFile(file.path, newContents);
        });

        return this;
    }

    end() {
        execSync('composer install', {cwd: this.basePath});
    }

}

module.exports = Runner;
