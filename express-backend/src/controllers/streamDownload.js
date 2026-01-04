import { progressMap } from "../utils/progressStore.js";
import { serverDownloadWithProgress } from "../utils/serverDownloadWithProgress.js";
import { streamUrlToMega } from "../utils/streamUrlToMega.js";
import { db, fileDownloads } from "../db/index.js";
import { eq } from "drizzle-orm";

export async function streamServerDownload(req, res){

    try {
        const {source_url, file_name, file_id} = req.body

        if (progressMap.get(file_id)) {
            return res.status(200).send({
                status: true,
                message: "file download already started",
                data: {
                    fileStatusId: file_id
                }
            })
        }

        let data = null;

        if(file_id) {
            [data] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, file_id)).limit(1);
        }
        if(!file_id || !data){
            [data] = await db.insert(fileDownloads).values({
                location: "server",
                sourceUrl: source_url,
                ...(file_name && {fileName:file_name})
            }).returning()
        }

        const id = data.id;
        
        const progressDetail = {
            "downloadedBytes":0,
            "totalBytes":null,
            "percentFixed2":null,
            "percent": null,
        }

        progressMap.set(id, progressDetail);

        serverDownloadWithProgress(id, source_url, {fileName: file_name}).catch(console.error)

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
        const { source_url, file_name, file_id } = req.body

        if (progressMap.get(file_id)) {
            return res.status(200).send({
                status: true,
                message: "file download already started",
                data: {
                    fileStatusId: file_id
                }
            })
        }

        let data = null;

        if(file_id) {
            [data] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, file_id))
        }
        if(!file_id || !data){
            [data] = await db.insert(fileDownloads).values({
                location: "server",
                sourceUrl: source_url,
                ...(file_name && {fileName:file_name})
            }).returning()
        }

        const id = data.id;

        const progressDetail = {
            "downloadedBytes": 0,
            "totalBytes": null,
            "percentFixed2": null,
            "percent": null,
        }
        progressMap.set(id, progressDetail);

        streamUrlToMega(id, source_url, {fileName: file_name}).catch(console.error)

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