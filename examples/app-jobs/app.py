# /// script
# requires-python = ">=3.12"
# dependencies = ["marimo"]
# ///
import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    from marimohub.jobs import Jobs

    mo.stop(mo.app_meta().request is None, mo.md("Job result: 42"))
    jobs = Jobs()
    tag = {"tag_key": "app", "tag_value": "shared-history-demo-v1"}
    return jobs, mo, tag


@app.cell
def _(mo):
    job_id = mo.ui.text(label="Job ID in this notebook")
    job_id
    return (job_id,)


@app.cell
def _(jobs, mo, tag):
    get_page, set_page = mo.state({"items": [], "next_cursor": None})
    get_active, set_active = mo.state({"items": [], "next_cursor": None})

    def load_first(_):
        set_page(jobs.list_history(**tag, status="succeeded", limit=1))
        set_active(jobs.list_history(**tag, status="active", triggered_by_me=True, limit=1))

    refresh = mo.ui.button(label="Refresh history and my active runs", on_click=load_first)
    refresh
    return get_active, get_page, set_active, set_page


@app.cell
def _(job_id, jobs, mo, tag):
    submit = mo.ui.button(
        label="Submit",
        on_click=lambda _: jobs.trigger(
            job_id.value, parameters={"value": "42"},
            tags={tag["tag_key"]: tag["tag_value"]},
        ),
    )
    submit
    return


@app.cell
def _(get_page, jobs, mo, set_page, tag):
    page = get_page()
    next_page = mo.ui.button(
        label="Next history page",
        disabled=page["next_cursor"] is None,
        on_click=lambda _: set_page(jobs.list_history(
            **tag, status="succeeded", limit=1, cursor=page["next_cursor"],
        )),
    )
    mo.vstack([
        mo.md("## Shared completed history"),
        mo.ui.table(page["items"]),
        mo.md("An empty page can still have a next page."),
        next_page,
    ])
    return


@app.cell
def _(get_active, jobs, mo, set_active, tag):
    active = get_active()
    next_active = mo.ui.button(
        label="Next page of my active runs",
        disabled=active["next_cursor"] is None,
        on_click=lambda _: set_active(jobs.list_history(
            **tag, status="active", triggered_by_me=True, limit=1,
            cursor=active["next_cursor"],
        )),
    )
    mo.vstack([mo.md("## My active runs"), mo.ui.table(active["items"]), next_active])
    return


if __name__ == "__main__":
    app.run()
