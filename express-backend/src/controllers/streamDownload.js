// import fs from "fs";
// import path from "path";
import { progressMap } from "../utils/progressStore.js";
import { nanoid } from 'nanoid'
import { serverDownloadWithProgress } from "../utils/serverDownloadWithProgress.js";
import { streamUrlToMega } from "../utils/streamUrlToMega.js";

export async function streamServerDownload(req, res){

    try {
        const {url} = req.body
        const id = nanoid(10);
        
        const progressDetail = {
            "downloadedBytes":0,
            "totalBytes":null,
            "percentFixed2":null,
            "percent": null,
        }
        progressMap.set(id, progressDetail);

        serverDownloadWithProgress(id,url).catch(console.error)

        return res.status(200).send({
            status: true,
            message: "message succesful recived",
            data:{
                fileStatusId: id
            }
        })
    } catch (error) {
        return res.status(500).send({
            details: error.message
        })
    }
}

export async function streamMegaUpload(req, res) {
    try{
        const { url } = req.body
        const id = nanoid(10);

        const progressDetail = {
            "downloadedBytes": 0,
            "totalBytes": null,
            "percentFixed2": null,
            "percent": null,
        }
        progressMap.set(id, progressDetail);

        streamUrlToMega(id, url).catch(console.error)

        return res.status(200).send({
            status: true,
            message: "message succesful recived",
            data:{
                fileStatusId: id
            }
        })

    } catch (error) {
        return res.status(500).send({
            details: error.message
        })
    }
    
}