import {

    createContext,

    useState,

} from "react";

import type {

    ReactNode,

} from "react";

import type {

    WorkspaceNode,

} from "../types/workspace";

import type {

    IDEContext,

} from "./IDEContext";

export interface Value extends IDEContext {

    setProjectTree(

        tree: WorkspaceNode[],

    ): void;

    setActiveFile(

        path: string,

    ): void;

    setActiveContent(

        content: string,

    ): void;

    addOpenedFile(

        path: string,

    ): void;

}

export const IDEContextObject =

    createContext<Value>(

        null!,

    );

export function IDEContextProvider({

    children,

}:{

    children: ReactNode;

}){

    const [

        projectTree,

        setProjectTree,

    ]=useState<WorkspaceNode[]>([]);

    const [

        activeFile,

        setActiveFile,

    ]=useState("");

    const [

        activeContent,

        setActiveContent,

    ]=useState("");

    const [

        openedFiles,

        setOpenedFiles,

    ]=useState<string[]>([]);

    function addOpenedFile(

        path:string,

    ){

        setOpenedFiles(

            previous=>{

                if(

                    previous.includes(path)

                ){

                    return previous;

                }

                return[

                    ...previous,

                    path,

                ];

            },

        );

    }

    return(

        <IDEContextObject.Provider

            value={{

                projectTree,

                activeFile,

                activeContent,

                openedFiles,

                setProjectTree,

                setActiveFile,

                setActiveContent,

                addOpenedFile,

            }}

        >

            {children}

        </IDEContextObject.Provider>

    );

}