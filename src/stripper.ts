import {readFileSync, writeFileSync} from "fs";

export default function (path: string){
    const file = readFileSync(path)
        .toString('utf8')
        .replaceAll(/\s*transformer:.*;$/g, '')
        .replaceAll(/\s*_input_out: .*;/g, '')
        .replaceAll(/\s*_input_out: {(?:[^_])*;/g, '')
        .replaceAll(/\s*_output_in: .*;/g, '')
        .replaceAll(/\s*_output_in: {(?:[^_])*;/g, '')
        .replaceAll(/\s*middleware: <([\s\S])*, TNewParams>;/g, '')
        .replaceAll(/\s*_ctx_out: any;/g, '')
        .replaceAll(/\s*_ctx_out: object;/g, '')
        .replaceAll(/\s*_meta: object;/g, '')
        .replaceAll(/\s*_config: import\("@trpc\/server"\)\.RootConfig<{[^}]*}>;/g, '')
    console.log(file);
    writeFileSync(path, file);
}
