import {

    useContext,

} from "react";

import {

    IDEContextObject,

} from "./IDEContextProvider";

export function useIDEContext(){

    return useContext(

        IDEContextObject,

    );

}